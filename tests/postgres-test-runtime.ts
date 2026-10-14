import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
export async function postgresTestRuntime(): Promise<{
  connectionString: string;
  close: () => void;
}> {
  const name = "tend-pg-test-" + randomUUID();
  execFileSync(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--publish",
      "127.0.0.1::5432",
      "--env",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "--env",
      "POSTGRES_USER=tend_test",
      "--env",
      "POSTGRES_DB=tend_test",
      "pgvector/pgvector:pg16",
    ],
    { stdio: "pipe" },
  );
  const close = () => {
    execFileSync("docker", ["stop", "--time", "1", name], { stdio: "pipe" });
  };
  try {
    const port = execFileSync("docker", ["port", name, "5432/tcp"], {
      encoding: "utf8",
    })
      .trim()
      .split(":")
      .at(-1)!;
    const connectionString = `postgresql://tend_test@127.0.0.1:${port}/tend_test`;
    for (let i = 0; i < 100; i++) {
      const pool = new Pool({ connectionString, connectionTimeoutMillis: 500 });
      try {
        await pool.query("SELECT 1");
        await pool.end();
        return { connectionString, close };
      } catch {
        await pool.end();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error("isolated PostgreSQL did not start");
  } catch (e) {
    close();
    throw e;
  }
}
