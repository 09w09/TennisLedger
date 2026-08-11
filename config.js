// Supabase 的 Project URL 和 Publishable Key 可以公开放在浏览器端。
// 真正的数据访问权限由 Supabase Auth + PostgreSQL RLS 控制。
// 绝对不要把 service_role / secret key 写进这个文件。
window.TENNIS_LEDGER_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT.supabase.co",
  supabasePublishableKey: "YOUR_PUBLISHABLE_KEY"
};
