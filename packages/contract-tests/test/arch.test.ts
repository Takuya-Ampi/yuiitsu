import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const root = join(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const srcFiles = (pkg: string) =>
  readdirSync(join(root, pkg, "src")).map((f) => [f, read(`${pkg}/src/${f}`)] as const);

// 14.1: core に DB ドライバ固有のエラーコード判定・方言ごとの分岐が存在せず、
// ライブラリ本体が DB ドライバ・認証ライブラリ・docker-compose に依存しない
describe("architecture rules", () => {
  it("core has no dialect branches or driver specific error handling", () => {
    for (const [file, text] of srcFiles("core")) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/===?\s*['"](postgres|mysql|sqlite)['"]/);
      expect(code, file).not.toMatch(/\.errno\b|SQLITE_|ER_[A-Z_]+|\b23505\b|\b40P01\b/);
      expect(code, file).not.toMatch(/from ['"](pg|mysql2|better-sqlite3|hono\/jwt)['"]/);
    }
  });

  it("library packages only declare peer dependencies on hono / zod-openapi / zod / kysely", () => {
    for (const pkg of ["core", "dialect-postgres", "dialect-mysql", "dialect-sqlite"]) {
      const json = JSON.parse(read(`${pkg}/package.json`));
      expect(json.dependencies ?? {}, pkg).toEqual({});
      const names = [
        ...Object.keys(json.peerDependencies ?? {}),
        ...Object.keys(json.devDependencies ?? {}),
      ];
      for (const n of names)
        expect(n, pkg).not.toMatch(/^(pg|mysql2|better-sqlite3|jsonwebtoken)$/);
    }
    const core = JSON.parse(read("core/package.json"));
    expect(Object.keys(core.peerDependencies).sort()).toEqual(
      ["@hono/zod-openapi", "hono", "kysely", "zod"].sort(),
    );
  });

  it("core does not depend on any dialect package", () => {
    for (const [file, text] of srcFiles("core")) {
      expect(text, file).not.toMatch(/@yuiitsu\/dialect-/);
    }
  });
});
