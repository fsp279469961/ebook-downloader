# 电子书下载器

一个基于 Node.js 的电子书下载工具，支持通过配置文件适配不同网站结构，无需修改代码即可兼容多个网站。

## 功能特性

- ✅ 通过配置文件适配不同网站（选择器、URL 等）
- ✅ 自动遍历所有章节分组页面（1-50 章、51-100 章等）
- ✅ 处理章节内分页（下载完整章节内容）
- ✅ 并行下载提高效率（默认 15 并发，可配置）
- ✅ 按网站顺序合并到单个 txt 文件（使用书名作为文件名）
- ✅ 重试机制（失败重试 3 次，指数退避）
- ✅ 实时进度显示

## 安装

```bash
npm install
```

## 使用方法

### 基本使用

```bash
node download_ebook.js <URL>
```

### 指定配置文件

```bash
node download_ebook.js <URL> --config custom_config.json
```

### 指定并发数

```bash
node download_ebook.js <URL> --concurrency 20
```

### 完整示例

```bash
# 使用默认配置
node download_ebook.js https://www.djks5.com/book/544247.html

# 使用自定义配置
node download_ebook.js https://www.djks5.com/book/544247.html --config custom_config.json

# 指定并发数
node download_ebook.js https://www.djks5.com/book/544247.html --concurrency 20
```

## 配置文件说明

配置文件使用 JSON 格式，主要包含以下部分：

### baseUrl

网站基础 URL，用于将相对 URL 转换为绝对 URL。

### selectors

所有 CSS 选择器配置：

- **bookTitle**: 书名选择器
- **chapterList**: 章节列表相关选择器
  - `container`: 章节列表容器选择器
  - `list`: 章节列表选择器
  - `item`: 章节项选择器
  - `link`: 章节链接选择器
  - `linkAttr`: 链接属性名（通常是 "href"）
- **chapterPagination**: 章节分页选择器
  - `selector`: 分页选择器（如 `select#indexselect`）
  - `option`: 选项选择器（通常是 "option"）
  - `valueAttr`: 值属性名（通常是 "value"）
- **chapterContent**: 章节内容相关选择器
  - `title`: 章节标题选择器
  - `content`: 章节内容选择器
  - `nextPage`: 下一页链接选择器
  - `nextPageAttr`: 下一页链接属性名（通常是 "href"）

### concurrency

默认并发数（建议 10-20）

### retry

重试配置：

- `maxAttempts`: 最大尝试次数（默认 3）
- `delays`: 延迟时间数组，单位毫秒（默认 [1000, 2000, 4000]）

## 适配新网站

要适配新网站，只需修改配置文件中的选择器：

1. 打开浏览器开发者工具（F12）
2. 访问目标网站，找到相应的元素
3. 复制元素的 CSS 选择器
4. 更新 `config.json` 中的对应选择器
5. 运行脚本测试

## 输出文件

下载完成后，会在当前目录生成以书名命名的 txt 文件，格式如下：

```
================================================================================
小说标题
================================================================================

第1章：标题
内容...

================================================================================

第2章：标题
内容...
```

## 注意事项

- 需要处理相对 URL 转绝对 URL（使用配置的 baseUrl）
- 章节标题中的分页信息（如 "1 / 3"）会自动清理
- 内容中的 HTML 标签会自动去除，只保留纯文本
- 使用 UTF-8 编码保存文件
- 配置文件选择器必须使用有效的 CSS 选择器语法

## 依赖

- `cheerio`: HTML 解析和 DOM 操作
- `axios`: HTTP 请求库
- `p-limit`: 并发控制

## 许可证

MIT
