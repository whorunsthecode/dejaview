/**
 * Google Docs export.
 *
 * Unlike Obsidian and Notion, Google needs OAuth. This uses
 * chrome.identity.launchWebAuthFlow rather than getAuthToken so the client id
 * lives in settings instead of the manifest — getAuthToken pins it to a published
 * extension id, which an unpacked build does not have a stable one of.
 *
 * Upload goes to Drive rather than the Docs API: Drive converts markdown to a
 * real Doc in one multipart request, where the Docs API would mean translating
 * the whole skill into batchUpdate requests for no gain.
 */

/** Only files this extension creates. It can never see the rest of the Drive. */
export const SCOPE = "https://www.googleapis.com/auth/drive.file";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

/** The redirect Chrome reserves for this extension. */
export function redirectUri() {
  return chrome.identity.getRedirectURL();
}

/**
 * Build the consent URL.
 *
 * Exported for testing: the parameters decide whether consent works at all, and
 * getting one wrong fails as an opaque Google error page.
 */
export function authUrl({ clientId, redirect, scope = SCOPE }) {
  const params = [
    ["client_id", clientId],
    ["response_type", "token"],
    ["redirect_uri", redirect],
    ["scope", scope]
  ];
  return AUTH + "?" + params.map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
}

/**
 * The access token comes back in the URL fragment of the redirect, not the query.
 * @returns {{token: string|null, error: string|null}}
 */
export function tokenFromRedirect(url) {
  const hash = String(url ?? "").split("#")[1];
  if (!hash) {
    const denied = /[?&]error=([^&]+)/.exec(String(url ?? ""));
    return { token: null, error: denied ? decodeURIComponent(denied[1]) : "no token in the redirect" };
  }

  const params = new URLSearchParams(hash);
  const error = params.get("error");
  if (error) return { token: null, error };

  const token = params.get("access_token");
  return token ? { token, error: null } : { token: null, error: "no access_token in the redirect" };
}

/**
 * Ask Google for an access token, prompting the user the first time.
 * @param {{clientId: string}} opts
 */
export async function getAccessToken({ clientId }) {
  if (!clientId) return { ok: false, error: "No Google client id set." };

  try {
    const redirect = redirectUri();
    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl({ clientId, redirect }),
      interactive: true
    });

    const { token, error } = tokenFromRedirect(responseUrl);
    return token ? { ok: true, token } : { ok: false, error };
  } catch (err) {
    // Closing the consent window lands here, which is a cancel, not a fault.
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** A multipart body, assembled by hand because FormData sets its own boundary. */
export function multipartBody({ metadata, content, boundary }) {
  return [
    "--" + boundary,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    "--" + boundary,
    "Content-Type: text/markdown; charset=UTF-8",
    "",
    content,
    "--" + boundary + "--",
    ""
  ].join("\r\n");
}

/**
 * Create a Google Doc from the skill. Always resolves.
 *
 * @param {{clientId: string, name: string, markdown: string}} opts
 */
export async function createGoogleDoc({ clientId, name, markdown }) {
  const auth = await getAccessToken({ clientId });
  if (!auth.ok) return { ok: false, error: auth.error };

  const boundary = "dejavu-" + Math.random().toString(36).slice(2);

  try {
    const response = await fetch(UPLOAD + "?uploadType=multipart&fields=id,webViewLink", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + auth.token,
        "Content-Type": "multipart/related; boundary=" + boundary
      },
      body: multipartBody({
        // The Docs mime type on a markdown upload is what makes Drive convert it
        // into a real document instead of storing a .md file.
        metadata: { name: name || "skill", mimeType: "application/vnd.google-apps.document" },
        content: markdown ?? "",
        boundary
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error?.message ?? response.status + " " + response.statusText);
    }
    return { ok: true, url: data.webViewLink, id: data.id };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
