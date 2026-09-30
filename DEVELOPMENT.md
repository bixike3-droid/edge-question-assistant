# 开发与检查

扩展运行只需源码目录，不需要构建。下面的工具仅供开发检查使用。

## 环境

- Node.js 20 或更新版本。
- `npm install` 安装开发用 Playwright；扩展自身不依赖 `node_modules`。
- 浏览器检查默认使用 Windows 中已安装的 Microsoft Edge，可用 `EDGE_EXECUTABLE` 指定路径。
- 需要 OpenSSL；Windows 默认使用 Git for Windows 自带版本，也可用 `OPENSSL_BINARY` 指定。
- `PLAYWRIGHT_MODULE` 可指定已有 Playwright 包路径，避免重复安装。

## 命令

```powershell
npm test
npm run test:browser
python scripts/package.py
```

单元检查覆盖记录迁移、备份冲突与无效输入、长对话图片上下文、API 错误/流式/超时/取消、数学与安全渲染、快捷键启动顺序。

浏览器检查在临时 Edge 配置中通过 DevTools 的 `Extensions.loadUnpacked` 加载真实扩展，不修改日常 Edge 配置。需要当前 Edge 支持该调试接口。浏览器窗口在屏幕外运行，检查包含真实截图、剪贴板写入、文件下载和 IndexedDB。

本地测试服务使用 HTTPS，运行时生成自签名测试证书。忽略该证书错误仅作用于测试浏览器。题目、图片与 PDF 都是人工样例；API 请求使用固定模拟响应，不读取私人 Key，不消耗 DeepSeek 额度。

临时结果、截图与测试证书写入 `.qa/`，不进入 Git 和发布包。临时浏览器配置在系统临时目录的 `question-extension-test-*` 下，检查结束关闭浏览器，保留配置用于排查，可自行清理。

## 发布

`python scripts/package.py` 在父目录生成版本 ZIP 和通用 ZIP。发布包只包含运行文件、图标、本地库/字体、许可证和说明，排除测试数据、开发依赖、Git 信息、嵌套旧目录和本地配置。

发布前应确认两类检查通过，且 `manifest.json`、`core.js`、`package.json` 三处版本一致。
