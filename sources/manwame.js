// Independently written site adapter. No login, cookies, telemetry or page JS.
class PersonalManwameNormal extends ComicSource {
  name = "漫蛙 · 个人测试源";
  key = "personal_manwame_normal";
  version = "0.1.0-alpha.2";
  minAppVersion = "1.18.1";
  url = "";
  origin = "https://manwame.com";
  headers = { "User-Agent": "Mozilla/5.0", Referer: "https://manwame.com/" };

  bookId(id) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,179}$/.test(id)) throw new Error("作品ID无效");
    return id;
  }

  bookLink(value) {
    if (typeof value !== "string") throw new Error("作品链接无效");
    const path = value.startsWith(this.origin + "/") ? value.slice(this.origin.length) : value;
    const match = path.match(/^\/book\/([a-zA-Z0-9_-]+)$/);
    if (!match) throw new Error("作品链接不属于当前站点或格式已变化");
    return this.bookId(match[1]);
  }

  coverUrl(value, id) {
    const match = typeof value === "string" && value.match(/^https:\/\/img\.manwame\.com\/cover\/([a-zA-Z0-9_-]+)\.(?:webp|jpg|jpeg|png)$/);
    if (!match || (id && match[1] !== id)) throw new Error("封面地址与当前作品或已验证图片线路不符");
    this.bookId(match[1]);
    return value;
  }

  optionalCover(value, id) {
    // Some site rows use other cover hosts. Keep the work searchable but do not
    // automatically contact a new host merely because it appeared in a list.
    try { return this.coverUrl(value, id); } catch { return ""; }
  }

  listPath(kind, keyword, page) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new Error("列表页码无效");
    if (kind !== "search" && kind !== "category") throw new Error("列表类型无效");
    return kind === "search" ? "/search?q=" + encodeURIComponent(keyword) + "&format=json&page=" + page :
      "/category" + (page > 1 ? "/page/" + page : "") + "?format=json";
  }

  validateNext(value, kind, keyword, page) {
    if (typeof value !== "string") throw new Error("列表下一页地址无效");
    const path = value.startsWith(this.origin + "/") ? value.slice(this.origin.length) : value;
    const split = path.indexOf("?");
    const expected = kind === "search" ? "/search" : "/category/page/" + (page + 1);
    if (split < 0 || path.slice(0, split) !== expected || path.includes("#")) throw new Error("列表下一页不属于当前查询");
    const pairs = {};
    try {
      for (const pair of path.slice(split + 1).split("&")) {
        const pos = pair.indexOf("="), key = decodeURIComponent(pair.slice(0, pos));
        if (pos < 1 || !["q", "format", "page"].includes(key) || Object.prototype.hasOwnProperty.call(pairs, key)) throw new Error();
        pairs[key] = decodeURIComponent(pair.slice(pos + 1).replace(/\+/g, " "));
      }
    } catch { throw new Error("列表下一页参数无效"); }
    if (pairs.format !== "json" || (kind === "search" ?
        pairs.page !== String(page + 1) || pairs.q !== keyword :
        Object.prototype.hasOwnProperty.call(pairs, "q") || Object.prototype.hasOwnProperty.call(pairs, "page"))) {
      throw new Error("列表下一页与当前查询或页码不符");
    }
  }

  async loadList(kind, keyword, page) {
    const body = await this.page(this.listPath(kind, keyword, page));
    let data;
    try { data = JSON.parse(body); } catch { throw new Error("站点未返回有效列表数据，可能要求验证或接口已变化"); }
    if (!data || data.page !== page || typeof data.has_more !== "boolean" ||
        !Array.isArray(data.rows) || data.rows.length > 1000 ||
        (kind === "search" && data.query !== keyword)) throw new Error("列表结构、搜索词或页码不符");
    if (data.has_more) {
      if (!data.rows.length || page === 10000) throw new Error("列表分页为空或超过安全上限");
      this.validateNext(data.next_page_url, kind, keyword, page);
    }
    const seen = new Set();
    const comics = [];
    for (const item of data.rows) {
      if (!item || typeof item.name !== "string" || !item.name.trim()) throw new Error("列表缺少作品标题");
      const id = this.bookLink(item.url);
      if (seen.has(id)) continue;
      seen.add(id);
      comics.push(new Comic({ id, title: item.name.trim(), cover: this.optionalCover(item.image, id),
        subtitle: typeof item.latestchapter?.title === "string" ? item.latestchapter.title : "" }));
    }
    // This endpoint exposes has_more rather than a total page count.
    return { comics, maxPage: data.has_more ? page + 1 : page };
  }

  search = {
    optionList: [],
    load: async (keyword, options, page) => {
      const query = String(keyword || "").trim();
      if (!query || query.length > 200) throw new Error("请输入1至200字的搜索词");
      return this.loadList("search", query, page);
    }
  };

  explore = [{
    title: "站点漫画列表", type: "multiPageComicList",
    load: async page => this.loadList("category", "", page)
  }];

  chapterPath(id, value) {
    this.bookId(id);
    if (typeof value !== "string") throw new Error("章节地址无效");
    const path = value.startsWith(this.origin + "/") ? value.slice(this.origin.length) : value;
    const match = path.match(/^\/book\/([a-zA-Z0-9_-]+)\/(\d+)\.html$/);
    if (!match || match[1] !== id || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) < 1) {
      throw new Error("章节链接不属于当前作品或格式已变化");
    }
    return path;
  }

  async page(path) {
    if (!/^\/book\/[a-zA-Z0-9_-]+(?:\/\d+\.html)?$/.test(path) &&
        !/^\/search\?q=(?:[a-zA-Z0-9_.!~*'()-]|%[0-9A-Fa-f]{2})+&format=json&page=[1-9]\d{0,4}$/.test(path) &&
        !/^\/category(?:\/page\/[1-9]\d{0,4})?\?format=json$/.test(path)) throw new Error("页面路径无效");
    const res = await Network.get(this.origin + path, this.headers);
    if (res.status !== 200) throw new Error("漫蛙请求失败：HTTP " + res.status);
    if (typeof res.body !== "string" || !res.body.length || res.body.length > 2000000) throw new Error("页面为空或超过安全上限");
    if (/Site Unavailable|Just a moment|challenge_required/.test(res.body.slice(0, 6000))) {
      throw new Error("站点当前不可访问或要求验证，请稍后再试");
    }
    return res.body;
  }

  decodeChapter(body, id, path) {
    this.chapterPath(id, path);
    const matches = Array.from(body.matchAll(/\bparams\s*=\s*'((?:\\.|[^'\\])*)'/g));
    if (matches.length !== 1 || matches[0][1].length > 1900000) throw new Error("章节参数缺失或格式已变化");
    let data;
    try {
      // Parse only a quoted Base64 literal; never execute page or advertising JS.
      const encoded = JSON.parse('"' + matches[0][1] + '"');
      if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded)) throw new Error("Invalid Base64 literal");
      const encrypted = new Uint8Array(Convert.decodeBase64(encoded));
      if (encrypted.length < 32 || encrypted.length % 16 !== 0) throw new Error("Invalid CBC length");
      // Public CMS client constant, not an account credential or private key.
      const key = Convert.encodeUtf8("5V&RoR%Jf@pJPydF");
      const plain = new Uint8Array(Convert.decryptAesCbc(encrypted.slice(16).buffer, key, encrypted.slice(0, 16).buffer));
      // Venera's AES interface returns raw CBC bytes without removing PKCS#7.
      const padding = plain[plain.length - 1];
      if (!plain.length || padding < 1 || padding > 16 || padding > plain.length ||
          !plain.slice(-padding).every(byte => byte === padding)) throw new Error("Invalid PKCS#7 padding");
      data = JSON.parse(Convert.decodeUtf8(plain.slice(0, -padding).buffer));
    } catch { throw new Error("章节参数解码失败，需检查站点协议后更新源"); }
    if (!data || data.host !== "manwame.com" || data.comic_url !== "/book/" + id ||
        data.comic_id !== "/book/" + id || data.chapter_url !== path || data.chapter_id !== path ||
        typeof data.comic_name !== "string" || !data.comic_name.trim()) {
      throw new Error("章节数据与当前作品或章节不匹配");
    }
    if (data.comic_status === "down") throw new Error("这部作品已被站点下架");
    if (data.comic_status !== "normal" || !Array.isArray(data.chapter_images) ||
        !data.chapter_images.length || data.chapter_images.length > 2000) {
      throw new Error("章节没有可验证的完整图片清单");
    }
    return data.chapter_images.map(url => this.imageUrl(url));
  }

  imageUrl(url) {
    if (typeof url !== "string" || !/^https:\/\/s1\.gimg\.top\/[a-zA-Z0-9_-]+$/.test(url)) {
      throw new Error("正文图片地址不在已验证的图片线路内，需检查后更新源");
    }
    return url;
  }

  comic = {
    loadInfo: async id => {
      this.bookId(id);
      const body = await this.page("/book/" + id);
      const doc = new HtmlDocument(body);
      try {
        const title = doc.querySelector("h1")?.text.trim();
        if (!title) throw new Error("作品详情缺少标题，页面格式可能已变化");
        const cover = this.optionalCover(doc.querySelector(".profile-cover img")?.attributes.src, id);
        const nodes = doc.querySelectorAll(".chapter-list a");
        if (!nodes.length) throw new Error(/已下架/.test(body) ? "这部作品已被站点下架" : "作品未提供可读目录");
        if (nodes.length > 10000) throw new Error("目录超过安全上限");
        const chapters = {};
        for (const node of nodes) {
          const path = this.chapterPath(id, node.attributes.href), title = node.text.trim();
          if (!title || Object.prototype.hasOwnProperty.call(chapters, path)) throw new Error("目录标签为空或包含重复章节");
          chapters[path] = title;
        }
        return new ComicDetails({ title, cover, description: doc.querySelector(".intro-text")?.text.trim() || "", tags: {}, chapters,
          url: this.origin + "/book/" + id });
      } finally { doc.dispose(); }
    },
    loadEp: async (id, epId) => {
      const path = this.chapterPath(id, epId);
      return { images: this.decodeChapter(await this.page(path), id, path) };
    },
    onImageLoad: url => ({ url: this.imageUrl(url), headers: this.headers }),
    onThumbnailLoad: url => {
      return { url: this.coverUrl(url), headers: this.headers };
    }
  };
}
