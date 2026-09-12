/**
 * Tool definitions the agent may call. All throw "not implemented".
 * The host wires these up either against the extension (via chrome messaging)
 * or against stubs.json (via run-local.js).
 */

export const toolSchemas = [
  {
    name: "list_tabs",
    description: "Return metadata for all open tabs. Cheap. Call first. No text is included.",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "read_tab",
    description: "Fetch the readable text of one tab. Expensive. Max 8 reads per run.",
    parameters: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "search_in_tab",
    description: "Search within one tab's text for a query. Use for long documents.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number" },
        query: { type: "string" }
      },
      required: ["id", "query"],
      additionalProperties: false
    }
  },
  {
    name: "web_search",
    description: "Fetch external results. Call only after stating a coverage gap.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "write_skill",
    description: "Terminal call. Emit the final SKILL.md and end the run.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        body: { type: "string" },
        sources: {
          type: "array",
          items: {
            type: "object",
            properties: {
              url: { type: "string" },
              firstVisit: { type: ["number", "null"] }
            },
            required: ["url", "firstVisit"]
          }
        }
      },
      required: ["name", "description", "body", "sources"],
      additionalProperties: false
    }
  }
];

export async function list_tabs() {
  throw new Error("not implemented");
}
export async function read_tab(/* id */) {
  throw new Error("not implemented");
}
export async function search_in_tab(/* id, query */) {
  throw new Error("not implemented");
}
export async function web_search(/* query */) {
  throw new Error("not implemented");
}
export async function write_skill(/* payload */) {
  throw new Error("not implemented");
}
