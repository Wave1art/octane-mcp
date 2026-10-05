import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compactEntity, compactList } from "../format.js";
import { defineTool, scopeOf, scopeShape, type Ctx } from "./shared.js";

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".bmp": "image/bmp",
  ".pdf": "application/pdf", ".txt": "text/plain", ".log": "text/plain", ".xml": "application/xml", ".json": "application/json",
  ".zip": "application/zip", ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".mp4": "video/mp4", ".csv": "text/csv",
};

export function registerAttachmentTools(server: McpServer, ctx: Ctx): void {
  defineTool(server, ctx, {
    name: "attachment_upload",
    title: "Upload an attachment",
    description:
      "Attach a file to a work item, test, run or requirement, from a local path or inline base64 content. " +
      "Octane checks that the extension matches the content and allows only whitelisted types (png, jpg, pdf, txt, log, xml, zip, docx, xlsx...).",
    schema: {
      owner_id: z.string().describe("Id of the item to attach to."),
      owner_type: z.enum(["work_item", "test", "run", "requirement", "task"]).optional().describe("Kind of item. Default work_item."),
      path: z.string().optional().describe("Local file path to upload."),
      content_base64: z.string().optional().describe("File content as base64, instead of path."),
      name: z.string().optional().describe("File name in Octane. Default: the path's basename. Required with content_base64."),
      description: z.string().optional(),
      ...scopeShape,
    },
    write: true,
    handler: async (a) => {
      let bytes: Uint8Array;
      let name = a.name;
      if (a.path) {
        bytes = new Uint8Array(await readFile(resolve(a.path)));
        name ??= basename(a.path);
      } else if (a.content_base64) {
        if (!name) throw new Error("name is required with content_base64.");
        bytes = new Uint8Array(Buffer.from(a.content_base64, "base64"));
      } else {
        throw new Error("Provide path or content_base64.");
      }
      const type = a.owner_type ?? "work_item";
      const created = await ctx.client.uploadAttachment(
        { name, content: bytes, contentType: MIME[extname(name).toLowerCase()], owner: { field: `owner_${type}`, type, id: a.owner_id }, description: a.description },
        scopeOf(a),
      );
      return { uploaded: created.map((e) => compactEntity(e)), size: bytes.byteLength };
    },
  });

  defineTool(server, ctx, {
    name: "attachment_download",
    title: "List or download attachments",
    description:
      "List the attachments on an item, or download one by attachment id to a local path (or return small text files inline).",
    schema: {
      owner_id: z.string().optional().describe("List attachments of this item."),
      owner_type: z.enum(["work_item", "test", "run", "requirement", "task"]).optional().describe("Kind of item for owner_id. Default work_item."),
      attachment_id: z.string().optional().describe("Download this attachment."),
      save_to: z.string().optional().describe("Local file or directory to save into. Omit to return text content inline (text files under 200 KB)."),
      ...scopeShape,
    },
    handler: async (a) => {
      const scope = scopeOf(a);
      if (a.attachment_id) {
        const meta = await ctx.client.get("attachments", a.attachment_id, ["id", "name", "size"], scope);
        const { bytes, contentType } = await ctx.client.downloadAttachment(a.attachment_id, scope);
        const name = String(meta?.name ?? `attachment-${a.attachment_id}`);
        if (a.save_to) {
          let target = resolve(a.save_to);
          if (!extname(target) || target.endsWith("/")) target = resolve(target, name);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, bytes);
          return { saved_to: target, name, size: bytes.byteLength, content_type: contentType };
        }
        const textual = /^(text\/|application\/(json|xml))/.test(contentType) || /\.(txt|log|csv|json|xml|md)$/i.test(name);
        if (textual && bytes.byteLength <= 200 * 1024) {
          return { name, size: bytes.byteLength, content_type: contentType, text: Buffer.from(bytes).toString("utf8") };
        }
        return { name, size: bytes.byteLength, content_type: contentType, note: "Binary or large file: pass save_to to write it to disk." };
      }
      if (!a.owner_id) throw new Error("Provide owner_id to list, or attachment_id to download.");
      const type = a.owner_type ?? "work_item";
      const list = await ctx.client.list("attachments", {
        query: `owner_${type} EQ {id EQ ${a.owner_id}}`,
        fields: ["id", "name", "size", "creation_time", "author"],
        orderBy: "-creation_time",
        limit: 200,
        scope,
      });
      return compactList(list);
    },
  });
}
