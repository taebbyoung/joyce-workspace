import {
  ensureWorkspace,
  getD1,
  getFilesBucket,
} from "@/db/runtime";

export const runtime = "edge";

function errorResponse(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

async function digest(bytes: ArrayBuffer) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function splitText(text: string, size = 2200, overlap = 250) {
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length && chunks.length < 600) {
    const next = Math.min(text.length, cursor + size);
    chunks.push(text.slice(cursor, next).trim());
    if (next === text.length) break;
    cursor = Math.max(cursor + 1, next - overlap);
  }
  return chunks.filter(Boolean);
}

export async function GET(request: Request) {
  try {
    await ensureWorkspace();
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return errorResponse("Document id is required.");
    const document = await getD1()
      .prepare(
        "SELECT file_name, mime_type, r2_key FROM source_documents WHERE id = ?",
      )
      .bind(id)
      .first<{ file_name: string; mime_type: string | null; r2_key: string | null }>();
    if (!document?.r2_key) {
      return errorResponse("原件尚未进入云端文件存储。", 404);
    }
    const object = await getFilesBucket().get(document.r2_key);
    if (!object) return errorResponse("File not found.", 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set(
      "content-disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(document.file_name)}`,
    );
    headers.set(
      "content-type",
      document.mime_type || "application/octet-stream",
    );
    return new Response(object.body, { headers });
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : "File could not be downloaded.",
      500,
    );
  }
}

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return errorResponse("请选择文件。");
    if (file.size > 20 * 1024 * 1024) {
      return errorResponse("Phase 1 单个文件上限为 20 MB。");
    }

    const allowedAuthorities = new Set([
      "verified_document",
      "internal_knowledge",
      "source_only",
    ]);
    const authorityValue = String(form.get("authority") ?? "source_only");
    const authority = allowedAuthorities.has(authorityValue)
      ? authorityValue
      : "source_only";
    const title =
      String(form.get("title") ?? "").trim().slice(0, 300) ||
      file.name.replace(/\.[^.]+$/, "");
    const documentType = String(
      form.get("documentType") ?? "other",
    ).slice(0, 80);
    const version = String(form.get("version") ?? "").trim().slice(0, 80);
    const versionStatus =
      String(form.get("versionStatus") ?? "current") === "archived"
        ? "archived"
        : "current";
    const productId = String(form.get("productId") ?? "").trim().slice(0, 100);
    const suppliedText = String(form.get("extractedText") ?? "").trim();

    const bytes = await file.arrayBuffer();
    const sha256 = await digest(bytes);
    const id = crypto.randomUUID();
    const extension = file.name.includes(".")
      ? `.${file.name.split(".").pop()?.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`
      : "";
    const r2Key = `source-documents/${id}/original${extension}`;
    await getFilesBucket().put(r2Key, bytes, {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
      customMetadata: {
        originalFileName: encodeURIComponent(file.name),
        sha256,
      },
    });

    let extractedText = suppliedText;
    if (
      !extractedText &&
      (file.type.startsWith("text/") ||
        /\.(txt|md|csv|json)$/i.test(file.name))
    ) {
      extractedText = new TextDecoder().decode(bytes);
    }
    extractedText = extractedText.slice(0, 1_200_000);
    const textChunks = splitText(extractedText);
    const now = new Date().toISOString();
    const db = getD1();
    const statements = [
      db
        .prepare(
          `INSERT INTO source_documents (
            id, title, file_name, document_type, product_id, version, version_status,
            authority, review_status, joyce_approved, r2_key, mime_type, file_size,
            sha256, indexing_status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'needs_review', 0, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          title,
          file.name,
          documentType,
          productId || null,
          version || null,
          versionStatus,
          authority,
          r2Key,
          file.type || "application/octet-stream",
          file.size,
          sha256,
          textChunks.length ? "indexed" : "not_indexed",
          now,
          now,
        ),
      db
        .prepare(
          `INSERT INTO files
            (id, r2_key, file_name, mime_type, file_size, sha256, entity_type, entity_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'source_document', ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          r2Key,
          file.name,
          file.type || "application/octet-stream",
          file.size,
          sha256,
          id,
          now,
        ),
      ...textChunks.map((chunk, index) =>
        db
          .prepare(
            `INSERT INTO document_chunks
              (id, document_id, page_number, section, content, authority, created_at)
             VALUES (?, ?, NULL, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            id,
            `Chunk ${index + 1}`,
            chunk,
            authority,
            now,
          ),
      ),
      db
        .prepare(
          `INSERT INTO audit_logs
            (id, action, entity_type, entity_id, after_data, source, created_at)
           VALUES (?, 'source_document_uploaded', 'source_document', ?, ?, 'user', ?)`,
        )
        .bind(
          crypto.randomUUID(),
          id,
          JSON.stringify({
            fileName: file.name,
            authority,
            sha256,
            chunks: textChunks.length,
          }),
          now,
        ),
    ];

    for (let index = 0; index < statements.length; index += 75) {
      await db.batch(statements.slice(index, index + 75));
    }

    return Response.json(
      {
        document: {
          id,
          title,
          fileName: file.name,
          authority,
          versionStatus,
          indexingStatus: textChunks.length ? "indexed" : "not_indexed",
          chunkCount: textChunks.length,
          sha256,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : "File could not be saved.",
      500,
    );
  }
}
