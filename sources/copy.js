// Independently implemented read-only adapter; no account or advertising APIs.
class PersonalCopy extends ComicSource {
  name = "拷贝 · 个人测试源";
  key = "personal_copy";
  version = "0.1.0-alpha.2";
  minAppVersion = "1.18.1";
  url = "";

  api = "https://api.copy2000.online";
  website = "https://www.copy5000.com";
  clientVersion = "3.0.9"; // Verified protocol; newer version text alone is not compatible.

  identifier(value) {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(value) ||
        ["__proto__", "constructor", "prototype"].includes(value)) {
      throw new Error("作品或章节标识无效");
    }
    return value;
  }

  // These are locally generated protocol identifiers, never phone hardware IDs.
  clientIdentity() {
    let identity = this.loadData("anonymous_client_v1");
    if (!identity || !/^\d{7}V-\d{4}$/.test(identity.deviceinfo || "") ||
        !/^[A-Z]{2}\d[A-Z]\.\d{6}\.\d{3}$/.test(identity.device || "") ||
        !/^[a-zA-Z0-9]{16}$/.test(identity.pseudoid || "")) {
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      const pick = alphabet => alphabet[Math.floor(Math.random() * alphabet.length)];
      const digits = length => Array.from({ length }, () => pick("0123456789")).join("");
      identity = {
        deviceinfo: "1" + digits(6) + "V-" + "1" + digits(3),
        device: pick("ABCDEFGHIJKLMNOPQRSTUVWXYZ") + pick("ABCDEFGHIJKLMNOPQRSTUVWXYZ") +
          digits(1) + pick("ABCDEFGHIJKLMNOPQRSTUVWXYZ") + "." + digits(6) + "." + digits(3),
        pseudoid: Array.from({ length: 16 }, () => pick(chars)).join("")
      };
      this.saveData("anonymous_client_v1", identity);
    }
    return identity;
  }

  requestHeaders() {
    const now = new Date();
    const timestamp = String(Math.floor(now.getTime() / 1000));
    // Public client protocol constants, not an account token or user secret.
    const protocolKey = Convert.decodeBase64("M2FmMDg1OTAzMTEwMzJlZmUwNjYwNTUwYTA1NjNhNTM=");
    return {
      "User-Agent": "COPY/" + this.clientVersion,
      source: "copyApp", platform: "3", region: "0",
      referer: "com.copymanga.app-" + this.clientVersion,
      version: this.clientVersion,
      Accept: "application/json",
      authorization: "Token",
      dt: now.toISOString().slice(0, 10).replace(/-/g, "."),
      ...this.clientIdentity(),
      umstring: "b4c89ca4104ea9a97750314d791520ac",
      "x-auth-timestamp": timestamp,
      "x-auth-signature": Convert.hmacString(protocolKey, Convert.encodeUtf8(timestamp), "sha256")
    };
  }

  async request(path) {
    if (!path.startsWith("/api/v3/")) throw new Error("拒绝非漫画API请求");
    const response = await Network.get(this.api + path, this.requestHeaders());
    if (response.status === 210 || response.status === 429) {
      let reason = "";
      try { const body = JSON.parse(response.body); reason = String(body.message || body.results?.detail || "").slice(0, 180); }
      catch { /* Keep the HTTP diagnosis if the response is not JSON. */ }
      const diagnosis = response.status === 210
        ? "拷贝拒绝请求（HTTP 210），可能涉及客户端版本、协议校验或访问限制。若提示更新APP，指拷贝客户端，并非VeneraNext；持续出现时需要检查源的兼容性。"
        : "拷贝请求过于频繁（HTTP 429），请暂停操作，稍后再试。";
      throw new Error(diagnosis + "本源不会自动重试或更换身份。" + (reason ? "服务器提示：" + reason : ""));
    }
    if (response.status !== 200) throw new Error("拷贝请求失败：HTTP " + response.status);
    let data;
    try { data = JSON.parse(response.body); }
    catch { throw new Error("拷贝返回了非JSON内容，请检查网络或站点状态"); }
    if (data.code !== 200) {
      throw new Error("拷贝API错误 " + data.code + "：" + String(data.message || "未知错误").slice(0, 180));
    }
    if (!data.results || typeof data.results !== "object" || Array.isArray(data.results)) {
      throw new Error("拷贝返回空数据，不能作为可用内容；可能是客户端协议变化或站点限制");
    }
    if (data.results.is_lock || data.results.is_banned) {
      throw new Error("站点限制了这部作品或章节的访问；本源不处理登录、付费或地区限制");
    }
    return data.results;
  }

  imageUrl(value) {
    if (typeof value !== "string" ||
        !/^https:\/\/[a-z0-9-]+\.mangafunb\.fun\/[a-z0-9][^\s<>"\\]*$/i.test(value)) {
      throw new Error("图片地址不在已验证的拷贝图片域名内，需检查后适配");
    }
    return value;
  }

  pageData(result) {
    if (!Array.isArray(result.list) || !Number.isSafeInteger(result.total) || result.total < 0) {
      throw new Error("拷贝列表结构发生变化");
    }
    return result;
  }

  search = {
    optionList: [],
    load: async (keyword, options, page) => {
      if (!Number.isSafeInteger(page) || page < 1) throw new Error("搜索页码无效");
      const limit = 30;
      const data = this.pageData(await this.request("/api/v3/search/comic?limit=" + limit +
        "&offset=" + ((page - 1) * limit) + "&q=" + encodeURIComponent(keyword) + "&q_type="));
      const comics = data.list.map(item => new Comic({
        id: this.identifier(item.path_word), title: String(item.name || ""),
        cover: this.imageUrl(item.cover),
        subtitle: Array.isArray(item.author) ? item.author.map(a => a.name).join(" / ") : ""
      }));
      return { comics, maxPage: Math.max(1, Math.ceil(data.total / limit)) };
    }
  };

  async groupChapters(comicId, group) {
    this.identifier(group.path_word);
    if (!Number.isSafeInteger(group.count) || group.count < 0 || group.count > 10000) {
      throw new Error("目录章节数量无效或超过安全上限");
    }
    const items = [], seen = new Set();
    let total = null, offset = 0;
    for (let page = 0; page < 100; page++) {
      const data = this.pageData(await this.request("/api/v3/comic/" + comicId + "/group/" +
        group.path_word + "/chapters?limit=100&offset=" + offset + "&in_mainland=true&request_id="));
      if (total === null) total = data.total;
      if (data.total !== total || total !== group.count || total > 10000 ||
          data.list.length > 100 || (data.offset !== undefined && data.offset !== offset)) {
        throw new Error("目录在加载中变化或分页异常，请重新打开作品");
      }
      if (!data.list.length && offset < total) throw new Error("目录中途返回空页，停止以免缺章");
      for (const item of data.list) {
        this.identifier(item.uuid);
        if (!item.name || seen.has(item.uuid) || item.comic_path_word !== comicId ||
            item.group_path_word !== group.path_word || !Number.isFinite(item.index)) {
          throw new Error("目录含重复、错位或缺少标识的章节");
        }
        seen.add(item.uuid); items.push(item);
      }
      offset += data.list.length;
      if (offset > total) throw new Error("目录数量超过站点声明");
      if (offset === total) {
        items.sort((a, b) => a.index - b.index);
        if (new Set(items.map(item => item.index)).size !== items.length) {
          throw new Error("目录阅读顺序重复，停止以免乱章");
        }
        const chapters = {};
        for (const item of items) chapters[item.uuid] = item.name;
        return chapters;
      }
    }
    throw new Error("目录超过100页，需人工检查后适配");
  }

  comic = {
    loadInfo: async id => {
      this.identifier(id);
      const data = await this.request("/api/v3/comic2/" + id + "?in_mainland=true&request_id=&platform=3");
      const item = data.comic;
      if (!item || item.path_word !== id || !item.name || !data.groups) {
        throw new Error("作品详情结构或标识异常");
      }
      const groups = Object.values(data.groups);
      if (!groups.length || groups.length > 20) throw new Error("作品分组为空或数量异常");
      const chapters = {}, allIds = new Set();
      for (const group of groups) {
        const label = String(group.name || group.path_word || "");
        if (!label || ["__proto__", "constructor", "prototype"].includes(label) ||
            Object.prototype.hasOwnProperty.call(chapters, label)) throw new Error("章节分组名称冲突");
        const entries = await this.groupChapters(id, group);
        for (const ep of Object.keys(entries)) {
          if (allIds.has(ep)) throw new Error("不同分组包含重复章节标识");
          allIds.add(ep);
        }
        if (Object.keys(entries).length) chapters[label] = entries;
      }
      if (!allIds.size) throw new Error("站点未提供可读目录");
      return new ComicDetails({
        title: item.name, cover: this.imageUrl(item.cover), description: String(item.brief || ""),
        tags: {
          "作者": Array.isArray(item.author) ? item.author.map(a => a.name) : [],
          "题材": Array.isArray(item.theme) ? item.theme.map(t => t.name) : []
        },
        chapters, updateTime: String(item.datetime_updated || ""), url: this.website + "/comic/" + id
      });
    },
    loadEp: async (comicId, epId) => {
      this.identifier(comicId); this.identifier(epId);
      const data = await this.request("/api/v3/comic/" + comicId + "/chapter2/" + epId +
        "?in_mainland=true&request_id=");
      const chapter = data.chapter;
      if (!chapter || chapter.uuid !== epId || chapter.comic_path_word !== comicId) {
        throw new Error("站点返回了不同作品或章节的数据");
      }
      const contents = chapter.contents, order = chapter.words;
      if (!Array.isArray(contents) || !contents.length || contents.length > 2000 ||
          !Array.isArray(order) || order.length !== contents.length || chapter.size !== contents.length) {
        throw new Error("章节图片数量不完整或排序表缺失");
      }
      const images = new Array(contents.length), positions = new Set(), urls = new Set();
      for (let i = 0; i < contents.length; i++) {
        const position = order[i];
        if (!Number.isInteger(position) || position < 0 || position >= contents.length || positions.has(position)) {
          throw new Error("章节图片排序表异常，停止以免乱页");
        }
        const url = this.imageUrl(contents[i]?.url);
        if (urls.has(url)) throw new Error("章节图片地址重复，需确认站点数据");
        positions.add(position); urls.add(url); images[position] = url;
      }
      return { images };
    },
    onImageLoad: url => ({ url: this.imageUrl(url), headers: { "User-Agent": "Mozilla/5.0", Referer: this.website + "/" } }),
    onThumbnailLoad: url => ({ url: this.imageUrl(url), headers: { "User-Agent": "Mozilla/5.0", Referer: this.website + "/" } })
  };
}
