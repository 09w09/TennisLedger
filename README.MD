# TennisLedger：零成本共享账本

这是一个给单个管理员使用的最小记账网页。它不需要自己购买服务器，也不需要安装复杂的前端框架。

- 网页：原生 HTML、CSS、JavaScript
- 免费网页托管：GitHub Pages（也保留 Cloudflare Pages 方案）
- 免费登录和数据库：Supabase Auth + PostgreSQL
- 权限：Supabase Auth + PostgreSQL Row Level Security（RLS）

> 本教程按 2026-08-12 的产品界面和免费计划编写。服务商以后可能调整菜单名称、免费额度或政策，遇到差异时以文末官方文档为准。

## 最终能做什么

- 只有管理员邮箱和密码登录后才能查看、修改数据
- 新建和删除“账本1、账本2……”
- 在某个账本中添加记账成员和初始余额
- 给成员增加或扣减余额
- 自动记录每次操作的时间、变动金额、修改前余额、修改后余额和备注
- 查看每个成员余额、总余额，以及按时间排列的全部历史记录
- 一键复制群聊可用的汇总文字
- 手机和电脑浏览器都能使用

账本删除采用“软删除”：它会从网页列表消失，但成员和历史记录仍保留在数据库中，避免误删后完全无法追查。

## 先分清两种“用户”

本项目里有两个很容易混淆的概念：

1. **管理员账号**：有邮箱和密码，可以登录网页、操作数据。它在 Supabase Authentication 中创建。
2. **账本成员**：例如“兵、波特、Eric”，只是账本里的记账对象，不需要邮箱、密码，也不能登录。

最小版本默认只有一个管理员；以后可以把第二个登录账号的 UUID 加入 `admins` 表来增加管理员。

## 为什么这套方案可以免费

| 用途 | 选择 | 对这个小项目的意义 |
| --- | --- | --- |
| 网页托管 | GitHub Pages / Cloudflare Pages | 免费托管静态文件并提供 HTTPS 网址 |
| 登录 | Supabase Auth | 不需要自己存储或校验明文密码 |
| 数据库 | Supabase PostgreSQL | 免费计划目前含 500 MB 数据库，对小账本非常充足 |
| 前端库 | Supabase JS CDN | 浏览器直接连接 Supabase，不需要另写后端服务器 |

Supabase 免费计划目前还包含 2 个活跃项目、50,000 MAU 和 5 GB 出站流量。500 MB 是每个项目的数据库容量；MAU 和出站流量按组织计算。这个单管理员账本通常远低于限制，但免费项目可能因低活动暂停，且免费计划不能替代你自己的备份；后文有维护说明。

```text
管理员浏览器
  ├── GitHub Pages 或 Cloudflare Pages：下载公开的网页代码
  └── Supabase
        ├── Auth：验证管理员邮箱和密码
        └── PostgreSQL：保存账本、成员、余额和操作记录
              └── RLS + RPC：在数据库里强制执行管理员权限
```

公开的是网页代码，不是账本数据。浏览器中使用的 Supabase Publishable Key 也设计为可公开；真正的数据权限由登录令牌、数据库授权和 RLS 共同决定。

## 开始前准备

只需要：

- 一个可以接收邮件的邮箱
- 一个 [GitHub](https://github.com/) 免费账号（使用本教程的 GitHub Pages 方案）
- 或一个 [Cloudflare](https://dash.cloudflare.com/) 免费账号（使用备用的 Cloudflare Pages 方案）
- 一个 [Supabase](https://supabase.com/dashboard) 免费账号
- 一个密码管理器，用来保存数据库密码和管理员密码

不需要购买域名，不需要购买云服务器，也不要求先学会 React、Node.js 或 SQL。

---

## 第 1 步：创建 Supabase 免费项目

1. 打开 [Supabase Dashboard](https://supabase.com/dashboard) 并登录。
2. 点击 **New project**。
3. 如果它要求先创建 Organization，创建一个免费的即可。
4. 项目名称可以填 `TennisLedger`。
5. 选择 **Free** 计划。
6. 为数据库生成一个强密码，立即保存到密码管理器。这个密码不是网页管理员密码。
7. Region 选择离你和主要使用者较近的区域。
8. 点击创建，等待项目初始化完成。

不要为了本教程开启付费 Add-on，也不需要填写自己的服务器信息。

## 第 2 步：建立数据库和权限

1. 在 Supabase 左侧打开 **SQL Editor**。
2. 点击 **New query**。
3. 打开本仓库的 [`supabase/schema.sql`](./supabase/schema.sql)。
4. 复制文件里的全部内容，粘贴到 SQL Editor。
5. 点击 **Run**。
6. 看到 `Success` 且没有红色错误，就完成了。

这段 SQL 会创建：

- `admins`：哪些登录账号是管理员
- `ledgers`：账本
- `members`：各账本中的成员和当前余额
- `transactions`：不可由浏览器直接篡改的操作记录
- `create_ledger`、`delete_ledger`、`add_member`、`adjust_balance`：受控的数据操作函数
- 数据表授权和 RLS 策略

`adjust_balance()` 会在同一个数据库事务中完成“锁定成员 -> 修改余额 -> 写入记录”。只要其中一步失败，整次操作都会回滚，不会出现余额改了却没有流水的半成品。

> 如果以前执行过旧版 `schema.sql`，也请重新执行当前文件一次，它会收紧直接写表权限并升级函数。

旧版若曾有人绕过网页直接改过流水，升级仍会先安全完成，但历史数学约束可能处于待验证状态。可以运行下面的审计；正常结果应为 0 行：

```sql
select id, balance_before, amount, balance_after
from public.transactions
where balance_after <> balance_before + amount;
```

结果为 0 行后，再执行：

```sql
alter table public.transactions
validate constraint transactions_balance_math_check;
```

如果查到异常行，先导出备份并人工核对，不要为了通过验证直接覆盖真实账目。

## 第 3 步：创建唯一的管理员账号

1. 左侧打开 **Authentication -> Users**。
2. 点击 **Add user**。
3. 选择创建新用户（界面可能写作 **Create new user**）。
4. 输入管理员邮箱和一个新的强密码。
5. 为了避免第一次使用被确认邮件卡住，本教程要求勾选 **Auto Confirm User**。如果界面只允许发送邀请，则必须打开邮件完成确认后才能登录；Supabase 默认邮件服务限额较低，也可能只向项目团队地址投递。
6. 创建后，复制该用户的 **User UID / UUID**。

回到 **SQL Editor -> New query**，执行下面的语句。只替换 UUID，不要保留中文占位文字：

```sql
insert into public.admins(user_id)
values ('这里替换成刚才复制的用户 UUID')
on conflict (user_id) do nothing;
```

例如 UUID 只能是类似这样的格式：

```text
12345678-1234-1234-1234-123456789abc
```

可以再执行下面的检查语句：

```sql
select user_id, created_at from public.admins;
```

结果中能看到刚才的 UUID，说明管理员授权成功。

### 关闭不需要的公开注册

这个网页本来就没有“注册”按钮，但公开注册 API 仍可能被调用，因此强烈建议继续在 Supabase 中关闭公开注册：

1. 打开 **Authentication -> Sign In / Providers -> User Signups**。
2. 关闭 **Allow new users to sign up**。
3. 确认 **Allow anonymous sign-ins** 没有开启。

Email 下的 **Confirm Email** 是另一项设置，不等于关闭注册。

关闭后，已有管理员仍然能登录，新账号只能由你在 Dashboard 中手动创建。

## 第 4 步：取得网页连接信息

优先点击 Supabase 项目顶部的 **Connect** 获取连接信息；也可以在 **Settings -> API Keys** 找 Key，并在 **Integrations -> Data API** 找 Project URL：

1. 复制 **Project URL**，格式通常是：

   ```text
   https://abcdefghijk.supabase.co
   ```

2. 复制 **Publishable Key**，新版通常以 `sb_publishable_` 开头。

如果旧项目还没有 `sb_publishable_...`，进入 **Settings -> API Keys -> Publishable and secret API keys**，点击 **Create new API keys** 创建 Publishable Key。Legacy `anon` 只用于迁移兼容，不建议新项目继续使用；Supabase 已宣布 legacy key 将在 2026 年底前弃用。

绝对不要复制以下任何凭据到网页代码：

- Secret Key
- `service_role` key
- 数据库密码
- Supabase 账号密码

它们拥有服务端高权限，泄露后可能绕过正常的网页权限。

## 第 5 步：取得网页文件并填写 `config.js`

先按准备采用的发布方式取得一份可以编辑的网页文件：

- **准备使用 GitHub Pages**：打开项目的 GitHub 仓库。如果仓库已经属于你，直接继续；否则点击右上角 **Fork -> Create fork**，复制到自己的账号。然后在自己的仓库中打开 `config.js`，点击铅笔图标 **Edit this file**。
- **准备使用 Cloudflare Pages 或先在本地运行**：在项目 GitHub 页面点击 **Code -> Download ZIP**，下载后解压，再用文本编辑器打开 `config.js`。

把 `config.js` 修改为：

```js
window.TENNIS_LEDGER_CONFIG = {
  supabaseUrl: "https://abcdefghijk.supabase.co",
  supabasePublishableKey: "sb_publishable_这里替换成你的Key"
};
```

GitHub 在线编辑完成后点击 **Commit changes**，保存到 `main` 分支；电脑上编辑则正常保存文件。注意：

- 两个值都要放在英文双引号中。
- URL 不能写成 Dashboard 的网页地址。
- 不要误填 Secret Key、`service_role` key 或数据库密码。
- Publishable Key 出现在公开 GitHub 仓库中是正常设计，不能单独用于绕过 RLS。

## 第 6 步：先在本地预览（推荐）

如果第 5 步已经在电脑上下载并解压项目，而且电脑已有 Python，可在项目目录执行：

```bash
python3 -m http.server 8080
```

然后用浏览器打开：

```text
http://localhost:8080
```

Windows 上如果 `python3` 不存在，可以试：

```bash
py -m http.server 8080
```

看到管理员登录页后，用第 3 步创建的邮箱和密码登录。验证完成后在终端按 `Ctrl + C` 停止本地服务器。只采用 GitHub 在线编辑、电脑上没有项目文件时，可以先跳过本地预览，上线后再完成第 8 步验收。

不建议长期直接双击 `index.html` 使用；本地 HTTP 服务或正式的 HTTPS 网站行为更稳定。

## 第 7 步：免费发布网页

下面两种方案任选一种即可。你如果确定使用 GitHub，直接完成方案 A，不需要再创建 Cloudflare 账号。

### 方案 A：GitHub Pages（从仓库自动发布）

GitHub Pages 会从仓库中的 HTML、CSS 和 JavaScript 文件生成网站。GitHub Free 使用 Pages 时，仓库需要设为 **Public**。

#### 7A-1. 创建或准备仓库

如果第 5 步已经准备好自己账号下的仓库并提交了 `config.js`，直接跳到 **7A-2. 开启 GitHub Pages**。

如果项目已经在你自己的 GitHub 仓库中，直接打开该仓库并继续下一小节。如果项目在别人的账号下，先点击右上角 **Fork -> Create fork**，将它复制到自己的账号。Fork 完成后，打开自己仓库中的 `config.js`，点击铅笔图标 **Edit this file**，填入第 4 步取得的两项连接信息，再点击 **Commit changes** 保存到 `main`。

如果还没有仓库：

1. 登录 [GitHub](https://github.com/)。
2. 点击右上角 **+ -> New repository**。
3. Repository name 填 `TennisLedger`。
4. Visibility 选择 **Public**。
5. 点击 **Create repository**。
6. 在空仓库的 **Quick setup** 页面点击 **uploading an existing file**；如果仓库已经有文件，则选择 **Add file -> Upload files**。
7. 打开电脑上的 `TennisLedger` 文件夹，把文件夹**里面的内容**拖入上传区，不要拖最外层的 `TennisLedger` 文件夹，然后点击 **Commit changes**。

“Commit changes”就是保存这一批文件修改。仓库根目录至少必须直接包含：

```text
index.html
styles.css
app.js
config.js
```

仓库自带的 `.nojekyll` 请保留；`README.MD` 和 `supabase/` 也可以留在仓库中，不影响网页运行。不要让文件变成 `TennisLedger/TennisLedger/index.html` 这样的双层目录。

确认第 5 步填写好的 `config.js` 已经上传或提交到 GitHub。只在电脑上修改但没有提交，线上网站不会得到新配置。

#### 7A-2. 开启 GitHub Pages

1. 打开自己的 `TennisLedger` 仓库。
2. 点击仓库上方的 **Settings**。屏幕较窄时，它可能藏在顶部的 `...` 菜单中。
3. 在左侧 **Code and automation** 下点击 **Pages**。
4. 在 **Build and deployment** 区域设置：
   - **Source**：`Deploy from a branch`
   - **Branch**：`main`
   - **Folder**：`/(root)`
5. 点击 **Save**。
6. 等待几分钟后刷新这个设置页面。看到站点已发布后，点击 **Visit site**。
7. 如果页面提供 **Enforce HTTPS** 选项，保持开启。

如果你的实际分支不叫 `main`，第 4 步应选择那个真正包含 `index.html` 的分支。

仓库网址和网站网址不是同一个地址：

```text
仓库：https://github.com/<GitHub用户名>/TennisLedger
网站：https://<GitHub用户名>.github.io/TennisLedger/
```

当前仓库的 Pages 网站地址通常会是：

```text
https://09w09.github.io/TennisLedger/
```

第一次发布或后续更新最多可能需要约 10 分钟。部署进度可以在仓库顶部的 **Actions** 页面查看，任务名称通常是 `pages build and deployment`。

#### 7A-3. 以后更新网站

以后修改网页时，把更新后的文件提交到同一个 `main` 分支即可：

- 在 GitHub 网页中编辑文件后点击 **Commit changes**；或
- 用 **Add file -> Upload files** 上传并覆盖文件；或
- 在电脑上使用 Git 提交并推送。

GitHub Pages 检测到新提交后会自动重新部署。Actions 显示绿色成功标记后，回到网站强制刷新浏览器即可看到新版。

### 方案 B：Cloudflare Pages（拖放上传）

Cloudflare Pages 支持直接拖放静态文件，不需要购买域名，也不需要写构建命令。

1. 在电脑上新建一个文件夹，例如 `tennisledger-site`。
2. 把下面 4 个文件复制到这个新文件夹中：

   ```text
   index.html
   styles.css
   app.js
   config.js
   ```

   `README.MD` 和 `supabase/schema.sql` 是教程与数据库安装文件，不需要发布到网站。

3. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) 并登录。
4. 进入 **Workers & Pages**。
5. 选择 **Create application -> Get started -> Drag and drop your files**。
6. 项目名称填 `tennis-ledger`，选择免费计划。
7. 把刚才的 `tennisledger-site` 文件夹拖入上传区域。
8. 确认上传列表的根目录直接能看到 `index.html`，不要让它外面再套一层文件夹。
9. 点击 **Deploy site**。
10. 部署完成后，网站地址类似：

    ```text
    https://tennis-ledger.pages.dev
    ```

    如果这个名称已被占用，Cloudflare 会给项目名加上随机字符。

Cloudflare Direct Upload 项目以后更新时，需要在项目页面点击 **Create a new deployment**，重新上传这 4 个文件。Direct Upload 项目不能原地切换为 Git integration；以后想自动部署时可以另建一个 Git-integrated Pages 项目。

## 第 8 步：第一次上线验收

不要一上线就录入唯一一份正式账目。先做下面这组测试：

1. 未登录时只能看到登录页，看不到任何账本。
2. 管理员能登录、退出，再次登录仍正常。
3. 创建 `测试账本1` 和 `测试账本2`。
4. 在测试账本1添加成员 `兵`，初始余额 `17728`。
5. 添加成员 `波特`，初始余额 `10000`。
6. 给波特输入 `-500`，备注填 `测试扣减`，余额应变成 `9500`。
7. 给波特输入 `1000`，备注填 `测试增加`，余额应变成 `10500`。
8. 操作记录中应同时看到修改前、变化、修改后和备注。
9. 页面总余额应为 `28228`。
10. 复制汇总，检查文字和页面一致。
11. 删除测试账本2，确认它从列表消失。
12. 手机浏览器打开同一个网址，确认能登录和操作。

如果想测试权限，可以在 Supabase Dashboard 再创建一个普通登录账号，但不要把它加入 `admins`；该账号应被网页拒绝，且不能读取账本表。

---

## 日常使用

### 新建账本

在账本首页输入名称，例如：

```text
账本1
账本2
2026年8月网球群
```

同一时间不能有两个同名账本。

### 添加成员和初始余额

进入一个账本，在“添加用户”区域输入姓名和初始余额。每次添加都会自动产生一条备注为“初始余额”的操作记录。

### 调整成员余额

点击成员右侧的“调整余额”，输入的是**本次变化量**：

- 增加 1000：输入 `1000` 或 `+1000`
- 扣减 500：输入 `-500`
- 金额最多保留两位小数
- 余额可以变成负数，页面会用红色提醒

弹窗会先显示预计修改后的余额。确认前检查“当前余额、变化量、预计修改后”是否正确。

不要直接输入想要的最终余额。例如当前是 `9514`，想改成 `9000`，本次变化应输入 `-514`。

### 查看历史

操作记录默认加载最新 100 条。点击“加载更早记录”可以继续查看，直到没有更早记录。

### 复制群聊汇总

输入题目中的示例数据后，“复制汇总”会得到：

```text
本群账单列表汇总：
兵账单汇总：17728
波特账单汇总：10000
刘子湘账单汇总：10000
Eric账单汇总：10000
玲账单汇总：10000
兀账单汇总：9514
李凡账单汇总：9352
陈陈账单汇总：8742
xiang账单汇总：7808
======
总账单汇总：93144
```

成员会按余额从高到低排列，小数余额会保留必要的小数位。

## 安全设计

当前权限边界是：

```text
未登录
  -> 不能读取或修改账本

普通已登录账号
  -> 只能判断自己是不是管理员，不能读取或修改账本

admins 表中的登录账号
  -> 可以读取账本
  -> 写入只能调用受控数据库函数
```

关键点：

- 前端隐藏按钮不是安全措施，真正的限制在 PostgreSQL 授权和 RLS。
- 浏览器账号没有数据表的直接写权限，不能绕过函数单独修改余额或伪造流水。
- 每次余额变化和操作记录在同一个数据库事务中提交。
- 修改余额时数据库会锁定该成员行，快速连续操作不会互相覆盖。
- 操作记录不能通过网页更新或删除。
- 名称和备注使用 `textContent` 显示，避免把输入内容当 HTML 执行。
- Supabase JS 锁定了具体版本，并通过 Content Security Policy 限制页面可加载的资源。

管理员密码建议至少 16 位并由密码管理器随机生成；Cloudflare、GitHub（如果使用）和 Supabase 账号都建议开启双重验证。

这仍然是一个轻量个人工具，不是经过审计的财务、支付或会计系统。不要存银行卡号、身份证号、登录密码等敏感资料。

## 免费计划的维护和备份

### 1. 项目暂停

Supabase Free 项目在低活动一段时间后可能自动暂停。官方当前说明是按约 7 天低活动判断，并会发送提醒邮件。

如果网页突然连接失败：

1. 登录 Supabase Dashboard。
2. 打开这个项目。
3. 如果显示 Paused，点击 **Resume project**。
4. 等项目恢复后刷新网页。

官方当前提供最长 1 年的暂停项目恢复窗口，但不要把它当永久备份。

### 2. 定期备份

免费计划不要依赖可下载的自动备份。按你能接受的数据损失决定频率；建议每次重要或批量改账后，并且至少每周一次：

1. 打开 Supabase **Table Editor**。
2. 分别打开 `ledgers`、`members`、`transactions`。
3. 使用导出 CSV 功能，把三个文件保存在电脑和另一个可靠位置。
4. 额外保存本仓库的 `supabase/schema.sql`。

CSV 只是便于人工查看的应急副本，不是一键恢复包，也不包含 Auth 登录账号。需要可恢复的数据库备份时，严格按 Supabase 官方教程分别导出角色、结构和数据；单独运行一次 `supabase db dump` 默认并不包含一切，也不会完整备份 Auth/Storage。本项目的 `admins.user_id` 和流水操作者都引用 Auth UUID，迁移到新项目时还需迁移 Auth 用户，或重新创建管理员并有计划地重新映射 UUID。应至少实际演练一次恢复。备份文件中可能包含姓名和账目信息，不要公开上传。

### 3. 不要删除 Supabase 项目

“删除网页中的账本”只是软删除；“删除整个 Supabase Project”则会永久删除数据库，性质完全不同。除非已有可靠备份，否则不要在 Dashboard 删除项目。

## 常见问题

### 页面只显示“还差两步”

`config.js` 仍是占位符，或修改后没有保存/上传。确认 `YOUR_PROJECT` 和 `YOUR_PUBLISHABLE_KEY` 已完全替换，然后强制刷新浏览器。

### 提示邮箱或密码错误

确认输入的是 Authentication 中创建的管理员账号，不是 Supabase Dashboard 登录密码或数据库密码。也检查账号是否已确认邮箱。

### 提示“这个账号不是管理员”

登录账号已创建，但它的 UUID 没有写入 `public.admins`。重新完成第 3 步，并检查复制的 UUID 是否属于当前登录邮箱。

### 创建账本或调整余额时报权限错误

重新在 SQL Editor 执行当前版本的 `supabase/schema.sql`，然后确认 `admins` 表中仍有管理员 UUID。

### 网页突然打不开数据，但静态页面正常

先去 Supabase Dashboard 检查项目是否因低活动暂停。如果没有暂停，再看浏览器网络是否能访问 `*.supabase.co`。

### Cloudflare Pages 显示 404

确认上传内容的根目录直接包含 `index.html`，没有多套一层 `tennisledger-site` 文件夹。重新创建一次 deployment 后等待片刻再刷新。

### GitHub Pages 显示 404 或没有更新

按下面顺序检查：

1. 仓库是 **Public**。
2. **Settings -> Pages** 仍选择了正确的分支和 `/(root)`。
3. 该分支根目录直接包含全小写的 `index.html`。
4. 打开仓库 **Actions**，检查最新的 `pages build and deployment` 是否成功。
5. 等待最多约 10 分钟，然后强制刷新浏览器。
6. 确认打开的是 `https://<用户名>.github.io/<仓库名>/`，而不是 `github.com` 的代码仓库地址。

如果首页正常但样式或按钮失效，检查 `styles.css`、`app.js` 和 `config.js` 是否也位于仓库根目录，并确认文件名大小写完全一致。

### Supabase JS 加载失败

浏览器访问 `cdn.jsdelivr.net` 失败。换一个网络测试，或以后把 Supabase JS 文件下载到仓库中改为本地引用。

### 中国大陆网络访问不稳定

Supabase、GitHub Pages 和 Cloudflare Pages 的普通免费服务都不承诺中国大陆境内节点或稳定性；Cloudflare 的中国网络是另行提供的 Enterprise 产品。正式录入数据前，请用实际要使用的手机、宽带和移动网络连续测试。若需要境内稳定商用访问，通常会涉及境内部署、域名备案等，不再是这个“完全免费 MVP”的范围。

## 项目文件

```text
TennisLedger/
├── .nojekyll          # GitHub Pages 使用；Cloudflare 部署不需要上传
├── index.html         # 页面结构
├── styles.css         # 页面样式和手机适配
├── app.js             # 登录与账本业务逻辑
├── config.js          # Project URL 和 Publishable Key
├── README.MD          # 本教程
└── supabase/
    └── schema.sql     # 数据表、权限和原子操作函数
```

## 以后可以增加，但第一版不需要

- “设置为指定余额”操作
- 删除或停用某个成员
- 给群成员开放无需登录的只读页面
- 搜索、日期筛选和 CSV/JSON 一键导出
- 管理员多因素认证
- 自定义域名

先把最小版本稳定用起来，再根据真实使用习惯增加功能，通常比一开始做一个复杂系统更可靠。

## 官方资料

- [Cloudflare Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
- [Cloudflare Pages Limits](https://developers.cloudflare.com/pages/platform/limits/)
- [GitHub Pages：创建网站](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)
- [GitHub Pages：配置发布来源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- [GitHub Pages：排查 404](https://docs.github.com/en/pages/getting-started-with-github-pages/troubleshooting-404-errors-for-github-pages-sites)
- [GitHub Pages Limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
- [Supabase Pricing](https://supabase.com/pricing)
- [Supabase Free Project Pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
- [Supabase Password Auth](https://supabase.com/docs/guides/auth/passwords)
- [Supabase Auth General Configuration](https://supabase.com/docs/guides/auth/general-configuration)
- [Supabase API Keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase Database Functions](https://supabase.com/docs/guides/database/functions)
- [Supabase Database Backups](https://supabase.com/docs/guides/platform/backups)
- [Supabase CLI Backup and Restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
