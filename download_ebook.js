#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import * as cheerio from "cheerio";
import pLimit from "p-limit";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// 配置加载模块
// ============================================================================

/**
 * 加载配置文件
 * @param {string} configPath - 配置文件路径
 * @returns {Promise<Object>} 配置对象
 */
async function loadConfig(configPath = "config.json") {
  try {
    // 处理相对路径和绝对路径
    const resolvedPath = path.isAbsolute(configPath)
      ? configPath
      : path.join(__dirname, configPath);

    const configContent = await fs.readFile(resolvedPath, "utf-8");
    const config = JSON.parse(configContent);

    // 验证配置完整性
    if (!config.baseUrl) {
      throw new Error("配置文件中缺少 baseUrl");
    }
    if (!config.selectors) {
      throw new Error("配置文件中缺少 selectors");
    }

    // 提供默认值
    config.concurrency = config.concurrency || 15;
    config.retry = config.retry || {
      maxAttempts: 3,
      delays: [1000, 2000, 4000],
    };

    return config;
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`配置文件不存在: ${configPath}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`配置文件格式错误: ${error.message}`);
    }
    throw error;
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 将相对URL转换为绝对URL
 * @param {string} url - 相对或绝对URL
 * @param {string} baseUrl - 基础URL
 * @returns {string} 绝对URL
 */
function resolveUrl(url, baseUrl) {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  const base = new URL(baseUrl);
  return new URL(url, base).href;
}

/**
 * 清理文件名中的非法字符
 * @param {string} filename - 原始文件名
 * @returns {string} 清理后的文件名
 */
function sanitizeFilename(filename) {
  return filename
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 清理标题中的分页信息
 * @param {string} title - 原始标题
 * @returns {string} 清理后的标题
 */
function cleanTitle(title) {
  if (!title) return "";
  // 移除类似 "（1 / 3）" 的分页信息
  return title.replace(/\s*\(?\d+\s*\/\s*\d+\)?\s*/g, "").trim();
}

/**
 * 延迟函数
 * @param {number} ms - 延迟毫秒数
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带重试的HTTP请求
 * @param {string} url - 请求URL
 * @param {Object} retryConfig - 重试配置
 * @returns {Promise<string>} HTML内容
 */
async function fetchWithRetry(url, retryConfig) {
  const { maxAttempts, delays } = retryConfig;
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: 30000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });
      return response.data;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts - 1) {
        const delayMs = delays[attempt] || delays[delays.length - 1];
        console.log(
          `   ⚠️  请求失败，${delayMs}ms 后重试 (${
            attempt + 1
          }/${maxAttempts})...`
        );
        await delay(delayMs);
      }
    }
  }

  throw new Error(`请求失败，已重试 ${maxAttempts} 次: ${lastError.message}`);
}

// ============================================================================
// 书名提取
// ============================================================================

/**
 * 从HTML中提取书名
 * @param {string} html - HTML内容
 * @param {Object} config - 配置对象
 * @returns {string} 书名
 */
function extractBookTitle(html, config) {
  const $ = cheerio.load(html);

  // 尝试使用配置的选择器
  if (config.selectors.bookTitle) {
    const title = $(config.selectors.bookTitle).first().text().trim();
    if (title) {
      return sanitizeFilename(title);
    }
  }

  // 从页面标题提取
  const pageTitle = $("title").text().trim();
  if (pageTitle) {
    // 尝试提取书名（通常格式：书名_网站名）
    const match = pageTitle.match(/^(.+?)[_\-|]/);
    if (match) {
      return sanitizeFilename(match[1]);
    }
    return sanitizeFilename(pageTitle);
  }

  return "未知书名";
}

// ============================================================================
// 章节列表获取
// ============================================================================

/**
 * 获取章节列表
 * @param {string} mainUrl - 主页面URL
 * @param {Object} config - 配置对象
 * @returns {Promise<Array<{url: string, title: string}>>} 章节列表
 */
async function getChapterList(mainUrl, config) {
  const chapters = [];
  const baseUrl = config.baseUrl;

  // 获取主页面
  console.log("📖 正在获取章节列表...");
  const mainHtml = await fetchWithRetry(mainUrl, config.retry);
  const $main = cheerio.load(mainHtml);

  // 检查是否有章节分页
  const paginationSelector = config.selectors.chapterPagination?.selector;
  let paginationUrls = [mainUrl];

  if (paginationSelector) {
    const $select = $main(paginationSelector);
    if ($select.length > 0) {
      const optionSelector =
        config.selectors.chapterPagination.option || "option";
      const valueAttr = config.selectors.chapterPagination.valueAttr || "value";

      $select.find(optionSelector).each((_, el) => {
        const value = $main(el).attr(valueAttr);
        if (value) {
          const fullUrl = resolveUrl(value, baseUrl);
          if (fullUrl && !paginationUrls.includes(fullUrl)) {
            paginationUrls.push(fullUrl);
          }
        }
      });

      console.log(`   发现 ${paginationUrls.length} 个章节分组页面`);
    }
  }

  // 遍历所有分页，收集章节链接
  const chapterSet = new Set(); // 用于去重

  for (const pageUrl of paginationUrls) {
    try {
      const pageHtml = await fetchWithRetry(pageUrl, config.retry);
      const $page = cheerio.load(pageHtml);

      const containerSelector = config.selectors.chapterList.container;
      const listSelector = config.selectors.chapterList.list;
      const itemSelector = config.selectors.chapterList.item;
      const linkSelector = config.selectors.chapterList.link;
      const linkAttr = config.selectors.chapterList.linkAttr || "href";

      const $container = $page(containerSelector);
      const $list = $container.find(listSelector);

      $list.find(itemSelector).each((_, el) => {
        const $item = $page(el);
        const $link = $item.find(linkSelector).first();
        const href = $link.attr(linkAttr);
        const title = $link.text().trim();

        if (href && title) {
          const fullUrl = resolveUrl(href, baseUrl);
          const urlKey = fullUrl.split("?")[0]; // 去除查询参数

          if (!chapterSet.has(urlKey)) {
            chapterSet.add(urlKey);
            chapters.push({
              url: fullUrl,
              title: title,
            });
          }
        }
      });
    } catch (error) {
      console.log(`   ⚠️  获取分页失败: ${pageUrl} - ${error.message}`);
    }
  }

  console.log(`   ✅ 共找到 ${chapters.length} 个章节`);
  return chapters;
}

// ============================================================================
// 章节下载（处理分页）
// ============================================================================

/**
 * 下载单个章节的所有分页内容
 * @param {string} url - 章节第一页URL
 * @param {Object} config - 配置对象
 * @returns {Promise<{title: string, content: string}>} 章节标题和内容
 */
async function downloadChapterPages(url, config) {
  const baseUrl = config.baseUrl;
  let title = "";
  let content = "";
  let currentUrl = url;
  const visitedUrls = new Set();

  while (currentUrl && !visitedUrls.has(currentUrl)) {
    visitedUrls.add(currentUrl);

    try {
      const html = await fetchWithRetry(currentUrl, config.retry);
      const $ = cheerio.load(html);

      // 提取标题（只在第一页提取）
      if (!title) {
        const titleSelector = config.selectors.chapterContent.title;
        if (titleSelector) {
          title = $(titleSelector).first().text().trim();
          title = cleanTitle(title);
        }
      }

      // 提取内容
      const contentSelector = config.selectors.chapterContent.content;
      if (contentSelector) {
        const $content = $(contentSelector).first();
        // 移除脚本和样式标签
        $content.find("script, style").remove();
        // 提取文本内容
        const pageContent = $content.text().trim();
        if (pageContent) {
          content += (content ? "\n\n" : "") + pageContent;
        }
      }

      // 查找下一页链接
      const nextPageSelector = config.selectors.chapterContent.nextPage;
      const nextPageAttr =
        config.selectors.chapterContent.nextPageAttr || "href";

      let nextUrl = null;
      if (nextPageSelector) {
        // 尝试匹配所有可能的下一页链接
        const $nextLinks = $(nextPageSelector);

        for (let i = 0; i < $nextLinks.length; i++) {
          const $nextLink = $($nextLinks[i]);
          const nextHref = $nextLink.attr(nextPageAttr);

          if (nextHref) {
            const resolvedNextUrl = resolveUrl(nextHref, baseUrl);

            // 跳过当前URL
            if (resolvedNextUrl && resolvedNextUrl !== currentUrl) {
              // 检查链接文本或rel属性
              // const linkText = $nextLink.text().trim();
              // const relAttr = $nextLink.attr("rel");

              // 判断是否是有效的下一页链接
              const isNextPage =
                // relAttr === "next" ||
                // linkText.includes("下一页") ||
                // linkText.includes("下一章") ||
                // linkText.includes("继续阅读") ||
                resolvedNextUrl.includes("_") &&
                resolvedNextUrl.match(/\d+_\d+\.html$/);

              if (isNextPage) {
                nextUrl = resolvedNextUrl;
                break;
              }
            }
          }
        }
      }

      currentUrl = nextUrl;
    } catch (error) {
      console.log(`   ⚠️  下载章节页面失败: ${currentUrl} - ${error.message}`);
      break;
    }
  }

  return { title: title || "未知标题", content: content.trim() };
}

// ============================================================================
// 并行下载控制
// ============================================================================

/**
 * 并行下载所有章节
 * @param {Array<{url: string, title: string}>} chapters - 章节列表
 * @param {Object} config - 配置对象
 * @returns {Promise<Array<{index: number, title: string, content: string, success: boolean, error?: string}>>} 下载结果
 */
async function downloadAllChapters(chapters, config) {
  const limit = pLimit(config.concurrency);
  const total = chapters.length;
  let completed = 0;
  const results = [];

  console.log(
    `\n📥 开始并行下载 ${total} 个章节（并发数: ${config.concurrency}）...\n`
  );

  const promises = chapters.map((chapter, index) => {
    return limit(async () => {
      try {
        const { title, content } = await downloadChapterPages(
          chapter.url,
          config
        );
        completed++;
        const percentage = ((completed / total) * 100).toFixed(1);
        console.log(
          `   ✅ [${completed}/${total}] (${percentage}%) - ${
            title || chapter.title
          }`
        );

        return {
          index,
          title: title || chapter.title,
          content,
          success: true,
        };
      } catch (error) {
        completed++;
        const percentage = ((completed / total) * 100).toFixed(1);
        console.log(
          `   ❌ [${completed}/${total}] (${percentage}%) - ${chapter.title} - ${error.message}`
        );

        return {
          index,
          title: chapter.title,
          content: "",
          success: false,
          error: error.message,
        };
      }
    });
  });

  const settledResults = await Promise.allSettled(promises);

  settledResults.forEach((result, i) => {
    if (result.status === "fulfilled") {
      results.push(result.value);
    } else {
      results.push({
        index: i,
        title: chapters[i].title,
        content: "",
        success: false,
        error: result.reason?.message || "未知错误",
      });
    }
  });

  return results;
}

// ============================================================================
// 文件合并
// ============================================================================

/**
 * 合并章节到文件
 * @param {Array<{index: number, title: string, content: string, success: boolean}>} chapters - 章节数据
 * @param {string} bookTitle - 书名
 * @returns {Promise<string>} 输出文件路径
 */
async function mergeToFile(chapters, bookTitle) {
  // 按索引排序
  const sortedChapters = [...chapters].sort((a, b) => a.index - b.index);

  // 生成输出文件名
  const outputFile = path.join(__dirname, `${bookTitle}.txt`);

  console.log(`\n📝 正在合并章节到文件: ${outputFile}`);

  try {
    let content = "";

    // 写入标题
    content +=
      "=".repeat(80) + "\n" + bookTitle + "\n" + "=".repeat(80) + "\n\n\n";

    // 写入章节内容
    let successCount = 0;
    let failCount = 0;

    for (const chapter of sortedChapters) {
      if (chapter.success && chapter.content) {
        content +=
          chapter.title +
          "\n" +
          chapter.content +
          "\n\n" +
          "=".repeat(80) +
          "\n\n";
        successCount++;
      } else {
        content +=
          chapter.title +
          "\n[下载失败: " +
          (chapter.error || "未知错误") +
          "]\n\n" +
          "=".repeat(80) +
          "\n\n";
        failCount++;
      }
    }

    // 写入文件
    await fs.writeFile(outputFile, content, "utf-8");

    console.log(`   ✅ 合并完成！`);
    console.log(`   📊 成功: ${successCount} 个章节`);
    if (failCount > 0) {
      console.log(`   ⚠️  失败: ${failCount} 个章节`);
    }
    console.log(`   📁 输出文件: ${outputFile}`);

    return outputFile;
  } catch (error) {
    throw new Error(`文件写入失败: ${error.message}`);
  }
}

// ============================================================================
// 主流程
// ============================================================================

/**
 * 解析命令行参数
 * @returns {Object} 解析后的参数
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    url: null,
    config: "config.json",
    concurrency: null,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && i + 1 < args.length) {
      result.config = args[++i];
    } else if (args[i] === "--concurrency" && i + 1 < args.length) {
      result.concurrency = parseInt(args[++i], 10);
    } else if (!result.url && args[i].startsWith("http")) {
      result.url = args[i];
    }
  }

  return result;
}

/**
 * 主函数
 */
async function main() {
  try {
    console.log("🚀 电子书下载器启动\n");

    // 解析命令行参数
    const args = parseArgs();
    if (!args.url) {
      console.error("❌ 错误: 请提供电子书URL");
      console.log("\n使用方法:");
      console.log(
        "  node download_ebook.js <URL> [--config <配置文件>] [--concurrency <并发数>]"
      );
      console.log("\n示例:");
      console.log(
        "  node download_ebook.js https://www.djks5.com/book/544247.html"
      );
      console.log(
        "  node download_ebook.js https://www.djks5.com/book/544247.html --config custom_config.json"
      );
      console.log(
        "  node download_ebook.js https://www.djks5.com/book/544247.html --concurrency 20"
      );
      process.exit(1);
    }

    // 加载配置
    console.log(`📋 加载配置文件: ${args.config}`);
    const config = await loadConfig(args.config);

    // 覆盖并发数（如果命令行指定）
    if (args.concurrency) {
      config.concurrency = args.concurrency;
      console.log(`   ⚙️  并发数: ${config.concurrency}`);
    }

    // 提取书名
    console.log(`\n📚 正在获取书名...`);
    const mainHtml = await fetchWithRetry(args.url, config.retry);
    const bookTitle = extractBookTitle(mainHtml, config);
    console.log(`   ✅ 书名: ${bookTitle}`);

    // 获取章节列表
    const chapters = await getChapterList(args.url, config);

    if (chapters.length === 0) {
      console.error("❌ 错误: 未找到任何章节");
      process.exit(1);
    }

    // 并行下载所有章节
    const results = await downloadAllChapters(chapters, config);

    // 合并到文件
    await mergeToFile(results, bookTitle);

    // 统计信息
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;

    console.log(`\n🎉 下载完成！`);
    console.log(`   📊 总计: ${results.length} 个章节`);
    console.log(`   ✅ 成功: ${successCount} 个`);
    if (failCount > 0) {
      console.log(`   ❌ 失败: ${failCount} 个`);
    }
  } catch (error) {
    console.error(`\n❌ 错误: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// 运行主函数
main();
