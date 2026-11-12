# AiWork 上游条款核查记录

核查日期：2026-11-09（Asia/Shanghai）。本记录是公开资料核查，不构成律师法律意见，也不构成上游授权证明。

## 已核实的官方材料

官网：<https://aiwork.dtagi.cn/home>。直接请求根地址会重定向至此页面。官网 HTML 加载 `https://edge.zkobjects.com/page/dtcoder-site/umi.fcf3af75.js`，并声明其静态资源前缀为 `https://edge.zkobjects.com/page/dtcoder-site/`。

官网法律栏所在资源：<https://edge.zkobjects.com/page/dtcoder-site/layouts__Marketing__index.95de1d2d.async.js>。该资源将“隐私政策”直接链接到：

<https://render.alipay.com/p/yuyan/180020010001196791/affichePreview.html?agreementId=AG01001812&version=v2.0.0>

该页面是动态页面。其自身公开 JS `common.b0036ae.js` 和 `affichePreview.a9c037b.js` 进一步指向无需登录的公开正文端点：

<https://antlegal.alipay.com/agreement/affichePreview?agreementId=AG01001812&version=v2.0.0&language=zh-Hans>

已成功获取完整正文，标题为《AiWork CN软件服务隐私政策》，主体为蚂蚁区块链科技（上海）有限公司，官方联系邮箱为 <pub_aiwork@antgroup.com>。这不是腾讯 WorkBuddy 的协议。

来源摘要保存在 [upstream-privacy-policy-2026-11-09.md](./upstream-privacy-policy-2026-11-09.md)，仓库不转载第三方政策全文。来源固定指定 `AG01001812`、`v2.0.0`，不保证对所有账号、产品、渠道均为最新适用版本。

## 对本项目有意义的已核实内容

隐私政策披露 device-code 登录、访问与刷新令牌、用户内容向模型服务商传输，以及 API Key、Token Plan 等计费信息处理。这些说明涉及数据处理，不能据此推导允许第三方复用桌面登录态、独立调用未公开接口、转售上游服务或重新分发上游程序。隐私政策中出现的 Proxy 技术也不构成本项目反代获得许可的证据。

## 服务协议核查结果及未验证事项

本次未获取可核实的完整《AiWork CN软件服务协议》或单独 API 使用协议。因此不能断言上游允许或禁止本项目具体接入方式，也不能以“未找到禁止条款”推定授权。

已执行的公开检索和检查：

- 公开网页检索 AiWork、Agentix、dtagi 及服务协议、用户协议、隐私关键词，未找到可与本产品可靠对应的完整服务协议；同名第三方产品未采用。
- 检查官网 HTML、主 `umi.fcf3af75.js` 及首页列出的全部路由异步 JS（含注册、下载、CLI、桌面端、价格、Marketing 布局等），查找协议、隐私、agreementId、服务条款入口。核实到上述隐私链接，未核实到完整服务协议链接。
- 公开请求 <https://aiwork-dl.dtagi.cn> 返回 HTTP 403。此结果仅描述根地址响应，不说明下载域名没有协议文件，亦未尝试绕过访问限制。
- 未登录官方账号，未读取本地凭据，未调用需身份认证的接口，未根据相邻 agreementId 猜测合同。

仍需核实：首次注册/CLI 登录展示的正式服务协议及版本、非官方客户端接入权限、桌面订阅与 API/Token Plan 权益边界、自动化调用与限流要求、账号/凭据共享和服务转售限制、上游安装包及运行时组件的再分发许可。官网隐私政策中的 API 描述没有解决这些问题。

## 发布判断

项目代码采用 MIT 只授权权利人有权许可的代码，不授予 AiWork 服务、账号、模型、商标或闭源组件权利。合规说明和免责声明同样不能代替上游授权。公开发布前应根据官方登录流程展示的合同或通过上述官方联系渠道取得明确说明；在未取得材料前，项目文档应如实披露“上游对当前接入方式的许可尚未核实”，不能宣称已获授权或保证不封号。

