import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "./mcp-server.ts";

/**
 * The synthetic MCP server over Streamable HTTP on this Mac, answering each request with plain
 * JSON. It wants `Authorization: Bearer <token>` and refuses anything else with 401, and keeps the
 * headers of every request so a test can see what Folio sent.
 */
export async function startHttpServer(token: string): Promise<{
  url: string;
  headers: Record<string, string | string[] | undefined>[];
  close: () => Promise<void>;
}> {
  const headers: Record<string, string | string[] | undefined>[] = [];
  const body = (request: IncomingMessage) =>
    new Promise<string>((done) => {
      let text = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (text += chunk));
      request.on("end", () => done(text));
    });
  let reply: ((message: unknown) => void) | undefined;
  const receive = serve((message) => reply?.(message));
  const server = createServer((request, response) => {
    headers.push({ ...request.headers });
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end("Unauthorized");
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    void body(request).then((text) => {
      const message = JSON.parse(text) as { id?: unknown; method?: string };
      if (message.id === undefined) {
        receive(message as never);
        response.writeHead(202).end();
        return;
      }
      reply = (answer) => {
        if ((answer as { id?: unknown }).id !== message.id) return;
        reply = undefined;
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
      };
      receive(message as never);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers,
    close: () => new Promise((done) => server.close(() => done())),
  };
}
