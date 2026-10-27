import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { uuidAny } from "../services/sql-any.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("uuidAny (GEM-1667)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const issueIds = [randomUUID(), randomUUID(), randomUUID()];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-sql-any-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values(
      issueIds.map((id, i) => ({ id, companyId, title: `Issue ${i}`, status: "todo", priority: "medium" })),
    );
  }, 20_000);

  afterAll(async () => {
    await db.delete(issues);
    await db.delete(companies);
    await tempDb?.cleanup();
  });

  it("binds the whole id list as one parameter, so the SQL text does not vary with list length", () => {
    const one = db.select({ id: issues.id }).from(issues).where(uuidAny(issues.id, [randomUUID()])).toSQL();
    const many = db
      .select({ id: issues.id })
      .from(issues)
      .where(uuidAny(issues.id, Array.from({ length: 50 }, () => randomUUID())))
      .toSQL();
    expect(one.params).toHaveLength(1);
    expect(many.params).toHaveLength(1);
    expect(many.sql).toBe(one.sql);
  });

  it("returns exactly the listed rows, and none for an empty list", async () => {
    const picked = await db
      .select({ id: issues.id })
      .from(issues)
      .where(uuidAny(issues.id, [issueIds[0], issueIds[2], randomUUID()]));
    expect(picked.map((r) => r.id).sort()).toEqual([issueIds[0], issueIds[2]].sort());

    const none = await db.select({ id: issues.id }).from(issues).where(uuidAny(issues.id, []));
    expect(none).toEqual([]);
  });
});
