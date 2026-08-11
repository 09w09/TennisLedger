# TennisLedger

一个尽量简单、零服务器维护成本的共享账本网页。

- 前端：GitHub Pages + 原生 HTML / CSS / JavaScript
- 登录和数据库：Supabase Auth + PostgreSQL
- 权限：PostgreSQL Row Level Security (RLS)
- 费用：按 GitHub Pages 与 Supabase Free Plan 的免费额度使用，不需要自购服务器

## 已实现

- 管理员邮箱/密码登录
- 新建和删除账本（删除采用软删除，不物理清除历史数据）
- 在账本中添加用户和初始余额
- 对用户余额执行 `+金额` / `-金额`
- 每次余额变动自动记录：用户、变动金额、修改前、修改后、备注、时间、操作者
- 查看各用户余额和总余额
- 按余额从高到低显示
- 一键复制类似下面的汇总文本：

```text
本群账单列表汇总：
兵账单汇总：17728.00
波特账单汇总：10000.00
兀账单汇总：9514.00
======
总账单汇总：37242.00
```

## 目录

```text
TennisLedger/
├── index.html
├── styles.css
├── app.js
├── config.js
└── supabase/
    └── schema.sql
```

## 第 1 步：创建 Supabase 项目

1. 登录 Supabase。
2. 创建一个新项目，例如 `TennisLedger`。
3. 等数据库初始化完成。

## 第 2 步：创建数据库

在 Supabase Dashboard 中打开：

`SQL Editor -> New query`

复制本仓库 [`supabase/schema.sql`](./supabase/schema.sql) 的全部内容并执行一次。

SQL 会创建：

- `admins`：管理员 UID
- `ledgers`：账本
- `members`：账本中的用户和当前余额
- `transactions`：不可由客户端修改/删除的余额操作记录
- RLS 权限策略
- `create_ledger` / `delete_ledger` / `add_member` / `adjust_balance` RPC

其中一次 `adjust_balance()` 会在同一个 PostgreSQL 事务中完成“修改余额 + 写操作记录”，避免两步操作只成功一半导致账目不一致。

## 第 3 步：创建管理员账号

打开：

`Authentication -> Users`

创建一个邮箱/密码用户，例如：

```text
admin@example.com
```

创建后复制该用户的 UUID，然后回到 SQL Editor 执行：

```sql
insert into public.admins(user_id)
values ('这里替换成你的用户 UUID');
```

只有 UID 存在于 `admins` 表中的已登录用户才能读取或修改账本数据。

> 如果你用 Dashboard 创建账号，注意账号是否已经处于可登录/邮箱已确认状态。

## 第 4 步：配置网页连接 Supabase

在 Supabase 项目中找到 Project URL 和 Publishable Key，然后编辑 [`config.js`](./config.js)：

```js
window.TENNIS_LEDGER_CONFIG = {
  supabaseUrl: "https://你的项目.supabase.co",
  supabasePublishableKey: "你的 Publishable Key"
};
```

### 安全说明

Project URL 和 Publishable Key 本来就是给浏览器客户端使用的，可以存在公开网页源码里。实际权限由登录用户的 JWT、PostgreSQL grants 与 RLS 一起控制。

**不要**把下面任何东西放进 `config.js`：

- `service_role` key
- Supabase Secret Key
- 数据库密码

这些属于服务端凭据，不应该出现在 GitHub Pages。

## 第 5 步：开启 GitHub Pages

GitHub 仓库打开：

`Settings -> Pages`

在 **Build and deployment** 中选择：

```text
Source: Deploy from a branch
Branch: main
Folder: /(root)
```

保存后，站点通常会发布到：

```text
https://09w09.github.io/TennisLedger/
```

## 日常使用

### 新建账本

例如：

```text
账本1
账本2
```

### 添加用户

例如：

```text
兵      17728
波特    10000
兀       9514
```

初始余额也会被写入操作记录，备注为“初始余额”。

### 修改余额

假设“兀”当前余额为 `9514`：

- 消费 500：输入 `-500`
- 增加 1000：输入 `1000` 或 `+1000`

不要直接输入修改后的最终余额。系统会根据“本次变动”自动计算新余额。

## 数据模型

```text
ledgers
  └── members
        └── transactions
```

余额变化示例：

```text
9514
  └── -500  -> 9014
        └── +1000 -> 10014
```

对应操作记录会保存：

```text
amount          -500
balance_before  9514
balance_after   9014
note            场地费
```

## 当前权限模型

当前版本采取更保守的方式：**只有管理员登录后才能查看账本内容，也只有管理员才能修改数据。**

```text
未登录
  -> 无数据访问权限

普通已登录账号
  -> 无账本数据访问权限

admins 表中的账号
  -> 可查看和操作账本
```

如果以后需要“其他人无需登录也可以只读查看余额，但只有管理员可以修改”，可以在此基础上单独增加只读 RLS policy。

## 本地预览（可选）

这不是必须步骤。直接 GitHub Pages 就可以运行。

如果你已经有 Python，可以在仓库目录执行：

```bash
python3 -m http.server 8080
```

然后打开：

```text
http://localhost:8080
```

不要直接双击 `index.html` 作为长期使用方式。
