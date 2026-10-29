// Independently written experimental adapter. No login, cookies, or telemetry.
class PersonalBaozi extends ComicSource {
  name = "包子 · 个人测试源";
  key = "personal_baozi";
  version = "0.1.0-alpha.1";
  minAppVersion = "1.18.1";
  url = ""; // Private repository: update by importing a downloaded file.

  origin = "https://cn.webmota.com";
  headers = { "User-Agent": "Mozilla/5.0", "Referer": "https://cn.webmota.com/" };

  absolute(value, base) {
    value = String(value || "").replace(/&amp;/g, "&").trim();
    if (value.startsWith("//")) return "https:" + value;
    if (/^https:\/\//i.test(value)) return value;
    if (value.startsWith("/")) return this.origin + value;
    if (/^[\w.-]+(?:\.html)?(?:\?.*)?$/.test(value)) {
      return base.slice(0, base.lastIndexOf("/") + 1) + value;
    }
    throw new Error("页面返回了不支持的链接");
  }

  trustedPage(value) {
    if (!/^https:\/\/cn\.webmota\.com\/comic(?:\/|$)/.test(value)) {
      throw new Error("拒绝访问来源之外的章节地址");
    }
    return value.split("#")[0];
  }

  chapterAddress(raw) {
    raw = String(raw || "").replace(/&amp;/g, "&");
    if (raw.startsWith("/user/page_direct?")) {
      const values = {};
      for (const pair of raw.split("?")[1].split("&")) {
        const split = pair.indexOf("=");
        if (split > 0) values[pair.slice(0, split)] = decodeURIComponent(pair.slice(split + 1));
      }
      if (!/^[\w-]+$/.test(values.comic_id || "") ||
          !/^\d+$/.test(values.section_slot || "") ||
          !/^\d+$/.test(values.chapter_slot || "")) {
        throw new Error("章节链接缺少站点给出的稳定编号");
      }
      return this.origin + "/comic/chapter/" + values.comic_id + "/" +
        values.section_slot + "_" + values.chapter_slot + ".html";
    }
    return this.trustedPage(this.absolute(raw, this.origin + "/"));
  }

  async document(url) {
    const response = await Network.get(url, this.headers);
    if (response.status !== 200) throw new Error("站点请求失败：HTTP " + response.status);
    if (/challenge_required|Just a moment|验证码/.test(response.body.slice(0, 6000))) {
      throw new Error("站点要求验证，请先用浏览器检查站点状态");
    }
    return new HtmlDocument(response.body);
  }

  cards(doc) {
    const result = [];
    const seen = new Set();
    for (const card of doc.querySelectorAll("div.comics-card")) {
      const link = card.querySelector("a[href]");
      const image = card.querySelector("amp-img, img");
      const title = card.querySelector("h3");
      const match = String(link?.attributes?.href || "").match(/\/comic\/([^/?#]+)/);
      if (!match || !title || seen.has(match[1])) continue;
      seen.add(match[1]);
      const rawCover = image?.attributes?.["data-src"] || image?.attributes?.src;
      result.push(new Comic({
        id: match[1], title: title.text.trim(),
        cover: rawCover ? this.absolute(rawCover, this.origin + "/") : ""
      }));
    }
    return result;
  }

  search = {
    optionList: [],
    load: async (keyword, options, page) => {
      if (page > 1) return { comics: [], maxPage: 1 };
      const doc = await this.document(this.origin + "/search?q=" + encodeURIComponent(keyword));
      try { return { comics: this.cards(doc), maxPage: 1 }; }
      finally { doc.dispose(); }
    }
  };

  // Follow only explicit same-chapter page links; never append the next chapter.
  continuation(doc, current) {
    const currentMatch = current.match(/\/(\d+_\d+)(?:_\d+)?\.html(?:\?.*)?$/);
    if (!currentMatch) throw new Error("章节地址格式发生变化");
    const currentBase = current.slice(0, current.lastIndexOf("/") + 1);
    const candidates = Array.from(doc.querySelectorAll("a[href]"));
    for (const link of candidates) {
      if (!/下一[页頁]|next\s*page/i.test(link.text)) continue;
      const target = this.trustedPage(this.absolute(link.attributes.href, current));
      const match = target.match(/\/(\d+_\d+)(?:_\d+)?\.html(?:\?.*)?$/);
      if (match && match[1] === currentMatch[1] && target.startsWith(currentBase)) return target;
      throw new Error("下一页链接指向不同作品或章节，停止以免混入内容");
    }
    return null;
  }

  comic = {
    loadInfo: async id => {
      if (!/^[\w-]+$/.test(id)) throw new Error("作品标识无效");
      const doc = await this.document(this.origin + "/comic/" + id);
      try {
        const title = doc.querySelector("h1");
        const cover = doc.querySelector('meta[property="og:image"]');
        const chapters = {};
        const nodes = doc.querySelectorAll("#chapter-items a, #chapters_other_list a");
        for (const node of nodes) {
          const href = node.attributes.href || "";
          const handler = node.attributes.onclick || node.attributes.on || "";
          let raw = href.includes("/comic/chapter/") || href.startsWith("/user/page_direct?") ? href : "";
          if (!raw) raw = node.attributes["data-url"] || "";
          if (!raw) raw = (handler.match(/[\"']([^\"']*\/comic\/chapter\/[^\"']+)[\"']/) || [])[1] || "";
          const label = node.text.trim();
          if (!raw || !label) continue;
          const url = this.chapterAddress(raw);
          chapters[url] = label;
        }
        if (!title || !Object.keys(chapters).length) {
          throw new Error("作品目录未能完整解析；请反馈页面结构，不生成猜测的章节编号");
        }
        return new ComicDetails({ title: title.text.trim(), tags: {},
          cover: cover ? this.absolute(cover.attributes.content, this.origin + "/") : "",
          chapters, url: this.origin + "/comic/" + id });
      } finally { doc.dispose(); }
    },
    loadEp: async (comicId, epId) => {
      let current = this.trustedPage(String(epId));
      const visited = new Set();
      const images = [];
      const seenImages = new Set();
      for (let page = 0; page < 30; page++) {
        if (visited.has(current)) throw new Error("章节分页形成循环，已停止，避免返回不完整章节");
        visited.add(current);
        const doc = await this.document(current);
        let next;
        try {
          const nodes = doc.querySelectorAll(".comic-contain amp-img, .comic-contain img");
          let valid = 0;
          for (const node of nodes) {
            const raw = node.attributes["data-src"] || node.attributes.src;
            if (!raw) continue;
            const url = this.absolute(raw, current);
            if (!/^https:\/\/[a-z0-9.-]+\/(?:[a-z]comic|comic)\//i.test(url)) continue;
            valid++;
            if (!seenImages.has(url)) { seenImages.add(url); images.push(url); }
          }
          if (!valid) throw new Error("章节页面没有正文图片，停止返回，避免把空页标成完整章节");
          next = this.continuation(doc, current);
        } finally { doc.dispose(); }
        if (!next) return { images };
        current = next;
      }
      throw new Error("章节超过30个分页，需人工确认后再调整上限");
    },
    onImageLoad: url => ({ url, headers: this.headers }),
    onThumbnailLoad: url => ({ url, headers: this.headers })
  };
}
