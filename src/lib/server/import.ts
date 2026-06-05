import { prisma } from "@/lib/db";
import { stringifyJson } from "@/lib/json";
import {
  detectPostmanPayload,
  normalizePostmanCollection,
  normalizePostmanEnvironment,
  previewPostmanImport,
  type NormalizedPostmanItem
} from "@/lib/postman-importer";
import { requestToPrismaInput, variableToPrismaInput } from "@/lib/server/data";

export async function importPostmanPayload(payload: unknown) {
  const type = detectPostmanPayload(payload);

  if (type === "collection") {
    return importCollection(payload);
  }

  if (type === "environment") {
    return importEnvironment(payload);
  }

  throw new Error("Unsupported Postman JSON.");
}

async function importCollection(payload: unknown) {
  const normalized = normalizePostmanCollection(payload);
  const preview = previewPostmanImport(payload);

  const collection = await prisma.collection.create({
    data: {
      name: normalized.name,
      preRequestScript: normalized.preRequestScript,
      postRequestScript: normalized.postRequestScript,
      rawPostmanJson: stringifyJson(payload),
      metadataJson: stringifyJson(normalized.metadata),
      variables: {
        create: normalized.variables.map((variable) => variableToPrismaInput(variable))
      }
    }
  });

  for (const [index, item] of normalized.items.entries()) {
    await createImportedItem(collection.id, null, item, index);
  }

  await prisma.importRecord.create({
    data: {
      type: "collection",
      name: normalized.name,
      summaryJson: stringifyJson(preview),
      warningsJson: stringifyJson(normalized.warnings),
      rawPostmanJson: stringifyJson(payload)
    }
  });

  return {
    type: "collection" as const,
    id: collection.id,
    preview
  };
}

async function importEnvironment(payload: unknown) {
  const normalized = normalizePostmanEnvironment(payload);
  const preview = previewPostmanImport(payload);

  const existingActive = await prisma.environment.findFirst({ where: { active: true } });

  const environment = await prisma.environment.create({
    data: {
      name: normalized.name,
      active: existingActive === null,
      rawPostmanJson: stringifyJson(payload),
      metadataJson: stringifyJson(normalized.metadata),
      variables: {
        create: normalized.variables.map((variable) => variableToPrismaInput(variable))
      }
    }
  });

  await prisma.importRecord.create({
    data: {
      type: "environment",
      name: normalized.name,
      summaryJson: stringifyJson(preview),
      warningsJson: stringifyJson(normalized.warnings),
      rawPostmanJson: stringifyJson(payload)
    }
  });

  return {
    type: "environment" as const,
    id: environment.id,
    preview
  };
}

async function createImportedItem(
  collectionId: string,
  parentId: string | null,
  item: NormalizedPostmanItem,
  sortOrder: number
) {
  if (item.type === "folder") {
    const folder = await prisma.folder.create({
      data: {
        collectionId,
        parentId,
        name: item.name,
        sortOrder,
        preRequestScript: item.preRequestScript,
        postRequestScript: item.postRequestScript,
        metadataJson: stringifyJson(item.metadata)
      }
    });

    for (const [index, child] of item.items.entries()) {
      await createImportedItem(collectionId, folder.id, child, index);
    }

    return;
  }

  await prisma.request.create({
    data: {
      ...requestToPrismaInput({
        collectionId,
        folderId: parentId,
        name: item.name,
        method: item.request.method,
        url: item.request.url,
        headers: item.request.headers,
        queryParams: item.request.queryParams,
        bodyMode: item.request.bodyMode,
        bodyRaw: item.request.bodyRaw,
        preRequestScript: item.request.preRequestScript,
        postRequestScript: item.request.postRequestScript,
        auth: item.request.auth
      }),
      collectionId,
      rawPostmanJson: stringifyJson(item.raw),
      metadataJson: stringifyJson({
        ...item.metadata,
        ...item.request.metadata
      })
    }
  });
}
