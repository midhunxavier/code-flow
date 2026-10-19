import { execFileSync } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
export async function certificateFixture(directory: string, hostname = "localhost", days = 2) {
  const config = join(directory, "openssl.cnf"), certPath = join(directory, "cert.pem"), keyPath = join(directory, "key.pem");
  await writeFile(config, `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=${hostname}\n[v3]\nsubjectAltName=DNS:${hostname}\n`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", String(days), "-config", config], { stdio: "ignore" });
  return { certPath, keyPath, cert: await readFile(certPath, "utf8"), key: await readFile(keyPath, "utf8"), hostname, source: "import" as const };
}
