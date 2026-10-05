// 起動中のサーバー(server.ts)に対する確認シナリオ。BASE_URL / JWT_SECRET を環境変数で指定できる。
// 終了コード: 全部通れば 0、1 つでも失敗すれば 1。
import { sign } from "hono/jwt";
import { INITIAL_STOCK } from "./connect.ts";

const base = process.env.BASE_URL ?? "http://localhost:3210";
const secret = process.env.JWT_SECRET ?? "dev-secret";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) failed++;
  console.info(`${ok ? "  ok  " : " FAIL "} ${label}${ok ? "" : `  -> ${JSON.stringify(detail)}`}`);
}

const headers = async (sub?: string) => ({
  "content-type": "application/json",
  ...(sub ? { authorization: `Bearer ${await sign({ sub }, secret, "HS256")}` } : {}),
});
async function call(method: string, path: string, sub?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: await headers(sub),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}
const stock = async () => Number((await call("GET", "/api/inventory", "alice")).json[0].stock);

console.info(`smoke: ${base}`);

check("認証なしは 401", (await call("GET", "/api/orders")).status === 401);

const o1 = await call("POST", "/api/orders", "alice", { total: 5 });
check(
  "POST 201 / 返るのは read 許可列だけ",
  o1.status === 201 && Object.keys(o1.json).sort().join() === "id,status,total",
  o1,
);
check("在庫が同じトランザクションで減る", (await stock()) === INITIAL_STOCK - 1);

const o2 = await call("POST", "/api/orders", "alice", { total: 9 });
check("2 件目の POST 201", o2.status === 201, o2);

const forbidden = await call("POST", "/api/orders", "alice", { total: 1, user_id: "bob" });
check("create 許可外の列(user_id)は 400", forbidden.status === 400, forbidden);
const hidden = await call("GET", "/api/orders?internal_note=eq.x", "alice");
check("read 許可外の列でのフィルタは 400", hidden.status === 400, hidden);
const bad = await call("POST", "/api/orders", "alice", { total: 0 });
check("CHECK 制約違反は 400", bad.status === 400 && bad.json?.error?.code === "invalid_value", bad);

const bobList = await call("GET", "/api/orders", "bob");
check(
  "他ユーザーには一覧に出ない(scope)",
  bobList.status === 200 && bobList.json.length === 0,
  bobList,
);
check(
  "他ユーザーの GET は 404",
  (await call("GET", `/api/orders/${o1.json.id}`, "bob")).status === 404,
);
check(
  "他ユーザーの PATCH は 404",
  (await call("PATCH", `/api/orders/${o1.json.id}`, "bob", { status: "x" })).status === 404,
);
check(
  "delete は operations に無いので 404/405",
  [404, 405].includes((await call("DELETE", `/api/orders/${o1.json.id}`, "bob")).status),
);

const patched = await call("PATCH", `/api/orders/${o1.json.id}`, "alice", { status: "paid" });
check("PATCH で status 更新", patched.status === 200 && patched.json.status === "paid", patched);

const sorted = await call("GET", "/api/orders?order=total.desc&total=gte.5", "alice");
check(
  "filter + order(total desc)",
  sorted.status === 200 && sorted.json.map((r: any) => r.total).join() === "9,5",
  sorted,
);
const paged = await call(
  "GET",
  "/api/orders?order=total.asc&limit=1&offset=1&select=id,total",
  "alice",
);
check(
  "limit / offset / select",
  paged.status === 200 &&
    paged.json.length === 1 &&
    paged.json[0].total === 9 &&
    !("status" in paged.json[0]),
  paged,
);
const inList = await call("GET", `/api/orders?id=in.(${o1.json.id},${o2.json.id})`, "alice");
check("in.(...)", inList.status === 200 && inList.json.length === 2, inList);

const o3 = await call("POST", "/api/orders", "alice", { total: 1 });
check("在庫ちょうどまで注文できる", o3.status === 201 && (await stock()) === 0, o3);
const soldOut = await call("POST", "/api/orders", "alice", { total: 1 });
check(
  "在庫切れは 400 で、注文ごとロールバック",
  soldOut.status === 400 && (await call("GET", "/api/orders", "alice")).json.length === 3,
  soldOut,
);

const doc = await call("GET", "/openapi.json");
check(
  "OpenAPI 3.1 が取得でき、internal_note を含まない",
  doc.json.openapi === "3.1.0" &&
    "/api/orders" in doc.json.paths &&
    doc.json.components.schemas.Orders.properties.internal_note === undefined,
);

console.info(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
