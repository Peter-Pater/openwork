import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ServerConfig } from "../types.js";
import { callGoogleWorkspaceExtensionAction, googleWorkspaceDisconnect, googleWorkspaceStatus } from "./google-workspace.js";

function createTestConfig(): ServerConfig {
  const tempDir = join(
    tmpdir(),
    `openwork-google-workspace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  return {
    host: "127.0.0.1",
    port: 8787,
    token: "test-client-token",
    hostToken: "test-host-token",
    configPath: join(tempDir, "server.json"),
    approval: { mode: "auto", timeoutMs: 30000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  };
}

function plaintextVaultPath(config: ServerConfig) {
  return join(dirname(config.configPath ?? ""), "extensions", "google-workspace", "oauth.dev-plaintext.json");
}

async function writePlaintextVault(config: ServerConfig, value: Record<string, unknown>) {
  const target = plaintextVaultPath(config);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function accountRecord(email: string, sub: string) {
  return {
    account: { email, name: email, sub, picture: null },
    scopes: ["openid"],
    token: { accessToken: `access-${sub}`, refreshToken: `refresh-${sub}`, expiresAt: Date.now() + 3600 * 1000 },
    connectedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const previousEnv = {
  devMode: process.env.OPENWORK_DEV_MODE,
  plaintextVault: process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT,
  clientSecret: process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET,
  legacyClientSecret: process.env.OPENWORK_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET,
  brokerUrl: process.env.OPENWORK_GOOGLE_WORKSPACE_TOKEN_BROKER_URL,
};
const previousFetch = globalThis.fetch;

function restoreEnv(key: string, value: string | undefined) {
  if (typeof value === "string") process.env[key] = value;
  else delete process.env[key];
}

afterEach(() => {
  restoreEnv("OPENWORK_DEV_MODE", previousEnv.devMode);
  restoreEnv("OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT", previousEnv.plaintextVault);
  restoreEnv("GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET", previousEnv.clientSecret);
  restoreEnv("OPENWORK_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET", previousEnv.legacyClientSecret);
  restoreEnv("OPENWORK_GOOGLE_WORKSPACE_TOKEN_BROKER_URL", previousEnv.brokerUrl);
  globalThis.fetch = previousFetch;
});

describe("Google Workspace extension", () => {
  test("reports only the user-configurable OAuth secret as missing", async () => {
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "";
    process.env.OPENWORK_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "";
    process.env.OPENWORK_GOOGLE_WORKSPACE_TOKEN_BROKER_URL = "";
    const status = await googleWorkspaceStatus(createTestConfig());
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual(["GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET"]);
  });

  test("reads multi-account vaults and exposes active account", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-two",
      accounts: [accountRecord("one@example.com", "sub-one"), accountRecord("two@example.com", "sub-two")],
    });

    const status = await googleWorkspaceStatus(config);
    expect(status.connected).toBe(true);
    expect(status.account?.email).toBe("two@example.com");
    expect(status.accounts.map((account) => account.email)).toEqual(["one@example.com", "two@example.com"]);
    expect(status.activeAccountId).toBe("sub-two");
  });

  test("disconnect can remove one connected account", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    globalThis.fetch = Object.assign(
      async () => new Response("{}", { status: 200 }),
      { preconnect: previousFetch.preconnect },
    );
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one"), accountRecord("two@example.com", "sub-two")],
    });

    const status = await googleWorkspaceDisconnect(config, "sub-one");
    expect(status.connected).toBe(true);
    expect(status.accounts.map((account) => account.email)).toEqual(["two@example.com"]);
    expect(status.activeAccountId).toBe("sub-two");
  });

  test("creates a google document", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    let calledUrl = "";
    let calledInit: any = undefined;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calledUrl = String(input);
        calledInit = init;
        return new Response(JSON.stringify({ documentId: "doc-123", title: "My Document" }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect }
    );
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one")],
    });
    
    const result = await callGoogleWorkspaceExtensionAction(config, "docs_create_document", { title: "My Document" }, {});
    expect(result?.ok).toBe(true);
    expect(calledUrl).toBe("https://docs.googleapis.com/v1/documents");
    expect(calledInit?.method).toBe("POST");
    expect(JSON.parse(calledInit?.body as string)).toEqual({ title: "My Document" });
  });

  test("reads a google document", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    let calledUrl = "";
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calledUrl = String(input);
        return new Response(JSON.stringify({ documentId: "doc-123", title: "My Document", body: { content: [] } }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect }
    );
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one")],
    });

    const result = await callGoogleWorkspaceExtensionAction(config, "docs_read_document", { documentId: "doc-123" }, {});
    expect(result?.ok).toBe(true);
    expect(calledUrl).toBe("https://docs.googleapis.com/v1/documents/doc-123");
  });

  test("updates a google document", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    let calledUrl = "";
    let calledInit: any = undefined;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calledUrl = String(input);
        calledInit = init;
        return new Response(JSON.stringify({ documentId: "doc-123" }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect }
    );
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one")],
    });

    const requests = [{ insertText: { text: "Hello", location: { index: 1 } } }];
       const result = await callGoogleWorkspaceExtensionAction(config, "docs_update_document", { documentId: "doc-123", requests }, {});
    expect(result?.ok).toBe(true);
    expect(calledUrl).toBe("https://docs.googleapis.com/v1/documents/doc-123:batchUpdate");
    expect(calledInit?.method).toBe("POST");
    expect(JSON.parse(calledInit?.body as string)).toEqual({ requests });
  });

  test("creates a google slides presentation", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    let calledUrl = "";
    let calledInit: any = undefined;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calledUrl = String(input);
        calledInit = init;
        return new Response(JSON.stringify({ presentationId: "slides-123", title: "My Presentation" }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect }
    );
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one")],
    });

    const result = await callGoogleWorkspaceExtensionAction(config, "slides_create_presentation", { title: "My Presentation" }, {});
    expect(result?.ok).toBe(true);
    expect(calledUrl).toBe("https://slides.googleapis.com/v1/presentations");
    expect(calledInit?.method).toBe("POST");
    expect(JSON.parse(calledInit?.body as string)).toEqual({ title: "My Presentation" });
  });

  test("creates a google spreadsheet", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    let calledUrl = "";
    let calledInit: any = undefined;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calledUrl = String(input);
        calledInit = init;
        return new Response(JSON.stringify({ spreadsheetId: "sheet-123", properties: { title: "My Sheet" } }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect }
    );
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one")],
    });

    const result = await callGoogleWorkspaceExtensionAction(config, "sheets_create_spreadsheet", { title: "My Sheet" }, {});
    expect(result?.ok).toBe(true);
    expect(calledUrl).toBe("https://sheets.googleapis.com/v4/spreadsheets");
    expect(calledInit?.method).toBe("POST");
    expect(JSON.parse(calledInit?.body as string)).toEqual({ properties: { title: "My Sheet" } });
  });

  test("gets spreadsheet cell values", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    let calledUrl = "";
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calledUrl = String(input);
        return new Response(JSON.stringify({ spreadsheetId: "sheet-123", range: "Sheet1!A1:B2", values: [["A", "B"], ["C", "D"]] }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect }
    );
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one")],
    });

    const result = await callGoogleWorkspaceExtensionAction(config, "sheets_get_values", { spreadsheetId: "sheet-123", range: "Sheet1!A1:B2" }, {});
    expect(result?.ok).toBe(true);
    expect(calledUrl).toBe("https://sheets.googleapis.com/v4/spreadsheets/sheet-123/values/Sheet1!A1%3AB2");
  });

  test("updates spreadsheet cell values", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    let calledUrl = "";
    let calledInit: any = undefined;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calledUrl = String(input);
        calledInit = init;
        return new Response(JSON.stringify({ spreadsheetId: "sheet-123" }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect }
    );
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one")],
    });

    const values = [["A", "B"], ["C", "D"]];
    const result = await callGoogleWorkspaceExtensionAction(config, "sheets_update_values", { spreadsheetId: "sheet-123", range: "Sheet1!A1:B2", values }, {});
    expect(result?.ok).toBe(true);
    expect(calledUrl).toBe("https://sheets.googleapis.com/v4/spreadsheets/sheet-123/values/Sheet1!A1%3AB2?valueInputOption=USER_ENTERED");
    expect(calledInit?.method).toBe("PUT");
    expect(JSON.parse(calledInit?.body as string)).toEqual({ values });
  });

  test("lists gmail messages", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    let calledUrl = "";
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calledUrl = String(input);
        return new Response(JSON.stringify({ messages: [{ id: "msg-123", threadId: "th-123" }] }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect }
    );
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one")],
    });

    const result = await callGoogleWorkspaceExtensionAction(config, "gmail_list_messages", { q: "from:test", maxResults: 5 }, {});
    expect(result?.ok).toBe(true);
    expect(calledUrl).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages?q=from%3Atest&maxResults=5");
  });

  test("gets gmail message details", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    let calledUrl = "";
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calledUrl = String(input);
        return new Response(JSON.stringify({ id: "msg-123", snippet: "Hello world" }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect }
    );
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one")],
    });

    const result = await callGoogleWorkspaceExtensionAction(config, "gmail_get_message", { id: "msg-123" }, {});
    expect(result?.ok).toBe(true);
    expect(calledUrl).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-123");
  });

  test("lists gmail threads", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    let calledUrl = "";
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calledUrl = String(input);
        return new Response(JSON.stringify({ threads: [{ id: "th-123", snippet: "Thread snippet" }] }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect }
    );
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one")],
    });

    const result = await callGoogleWorkspaceExtensionAction(config, "gmail_list_threads", { q: "subject:test", maxResults: 3 }, {});
    expect(result?.ok).toBe(true);
    expect(calledUrl).toBe("https://gmail.googleapis.com/gmail/v1/users/me/threads?q=subject%3Atest&maxResults=3");
  });

  test("gets gmail thread details", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    let calledUrl = "";
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calledUrl = String(input);
        return new Response(JSON.stringify({ id: "th-123", messages: [] }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect }
    );
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one")],
    });

    const result = await callGoogleWorkspaceExtensionAction(config, "gmail_get_thread", { id: "th-123" }, {});
    expect(result?.ok).toBe(true);
    expect(calledUrl).toBe("https://gmail.googleapis.com/gmail/v1/users/me/threads/th-123");
  });
});
