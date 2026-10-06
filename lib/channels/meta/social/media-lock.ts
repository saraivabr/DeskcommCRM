import type { PoolClient, QueryConfig, QueryResultRow } from "pg";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { MetaIntegrationError } from "./types";

export function queryMetaMedia<T extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  text: string,
  values: unknown[] = [],
) {
  const query: QueryConfig<unknown[]> & { query_timeout: number } = {
    text,
    values,
    query_timeout: 15_000,
  };
  return client.query<T>(query);
}

type TimedQueryConfig = QueryConfig<[string]> & { query_timeout: number };

/** Session lock spans I/O without keeping a database transaction open. */
export async function withMetaMediaLock<T>(
  connectionId: string,
  shared: boolean,
  work: (client: PoolClient) => Promise<T>,
  publication?: { organizationId: string; id: string },
): Promise<T> {
  const client = await getRequestPool().connect();
  const key = `meta-privacy-connection:${connectionId.toLowerCase()}`;
  const acquire = shared ? "pg_try_advisory_lock_shared" : "pg_try_advisory_lock";
  const release = shared ? "pg_advisory_unlock_shared" : "pg_advisory_unlock";
  let acquired = false;
  let destroy = false;
  let publicationLocked = false;
  const publicationKey = publication
    ? `meta-media-preparation:${publication.organizationId.toLowerCase()}:${publication.id.toLowerCase()}`
    : undefined;
  let oldStatementTimeout: string | undefined;
  try {
    try {
      const query: TimedQueryConfig = {
        text: `select ${acquire}(hashtextextended($1,0)) as locked`,
        values: [key],
        query_timeout: 5_000,
      };
      const result = await client.query<{ locked: boolean }>(query);
      acquired = result.rows[0]?.locked === true;
    } catch (error) {
      // A timed-out response can hide an acquired lock; never reuse the session.
      destroy = true;
      throw error;
    }
    if (!acquired)
      throw new MetaIntegrationError(
        "meta_preparation_busy",
        "Esta autorização está em limpeza. Atualize antes de continuar.",
        409,
      );
    const original = await queryMetaMedia<{ timeout: string }>(
      client,
      "select current_setting('statement_timeout') as timeout",
    );
    oldStatementTimeout = original.rows[0]?.timeout;
    if (!oldStatementTimeout) throw new Error("Missing preparation statement timeout");
    await queryMetaMedia(client, "select set_config('statement_timeout','15s',false)");
    if (publicationKey) {
      const result = await queryMetaMedia<{ locked: boolean }>(
        client,
        "select pg_try_advisory_lock(hashtextextended($1,0)) as locked",
        [publicationKey],
      );
      publicationLocked = result.rows[0]?.locked === true;
      if (!publicationLocked)
        throw new MetaIntegrationError(
          "meta_preparation_busy",
          "Esta publicação já está em preparação. Atualize antes de continuar.",
          409,
        );
    }
    return await work(client);
  } catch (error) {
    // Close sessions after uncertain writes or failed I/O, cancelling any
    // outstanding command and releasing all session locks server-side.
    destroy = acquired || destroy;
    throw error;
  } finally {
    if (acquired && !destroy) {
      try {
        if (publicationLocked) {
          const result = await queryMetaMedia<{ unlocked: boolean }>(
            client,
            "select pg_advisory_unlock(hashtextextended($1,0)) as unlocked",
            [publicationKey],
          );
          if (result.rows[0]?.unlocked !== true) throw new Error("Uncertain publication unlock");
        }
        if (oldStatementTimeout)
          await queryMetaMedia(client, "select set_config('statement_timeout',$1,false)", [
            oldStatementTimeout,
          ]);
        const query: TimedQueryConfig = {
          text: `select ${release}(hashtextextended($1,0)) as unlocked`,
          values: [key],
          query_timeout: 5_000,
        };
        const result = await client.query<{ unlocked: boolean }>(query);
        destroy = result.rows[0]?.unlocked !== true;
      } catch {
        destroy = true;
      }
    }
    client.release(destroy);
  }
}
