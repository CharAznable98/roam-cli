import {
  DEFAULT_MAX_IMAGE_BYTES,
  type ImageAttachmentUpload,
  type RunnerCapability,
} from "@roamcli/shared/protocol";

export interface DraftImageAttachment {
  id: string;
  file: File;
  previewUrl: string;
}

export interface ImageInputLimits {
  supported: boolean;
  accept: string;
  maxImages: number;
  maxBytes: number;
  supportedMimeTypes: string[];
}

export function imageInputLimits(
  capability: RunnerCapability | undefined,
): ImageInputLimits {
  const supportedMimeTypes = capability?.supportedImageMimeTypes ?? [];
  return {
    supported: capability?.supportsImages === true,
    accept:
      supportedMimeTypes.length > 0 ? supportedMimeTypes.join(",") : "image/*",
    maxImages: capability?.maxImagesPerTurn ?? 0,
    maxBytes: capability?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
    supportedMimeTypes,
  };
}

export function addDraftImages(
  files: readonly File[],
  existing: readonly DraftImageAttachment[],
  capability: RunnerCapability | undefined,
): { attachments: DraftImageAttachment[]; error?: string } {
  const limits = imageInputLimits(capability);
  if (!limits.supported) {
    return {
      attachments: [],
      error: "This agent does not accept image input.",
    };
  }

  const maxImages =
    limits.maxImages > 0 ? limits.maxImages : Number.POSITIVE_INFINITY;
  const remaining = maxImages - existing.length;
  if (remaining <= 0) {
    return {
      attachments: [],
      error: `You can attach up to ${limits.maxImages} images.`,
    };
  }

  const attachments: DraftImageAttachment[] = [];
  for (const file of files) {
    if (attachments.length >= remaining) {
      return {
        attachments,
        error: `You can attach up to ${limits.maxImages} images.`,
      };
    }
    if (!file.type.startsWith("image/")) {
      return { attachments, error: `${file.name} is not an image file.` };
    }
    if (
      limits.supportedMimeTypes.length > 0 &&
      !limits.supportedMimeTypes.includes(file.type)
    ) {
      return {
        attachments,
        error: `${file.type || "This image type"} is not supported.`,
      };
    }
    if (file.size > limits.maxBytes) {
      return {
        attachments,
        error: `${file.name} is larger than ${formatBytes(limits.maxBytes)}.`,
      };
    }
    attachments.push({
      id: `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      file,
      previewUrl: createPreviewUrl(file),
    });
  }
  return { attachments };
}

export async function draftImagesToUploads(
  attachments: readonly DraftImageAttachment[],
): Promise<ImageAttachmentUpload[]> {
  return Promise.all(
    attachments.map(async (attachment) => ({
      name: attachment.file.name || "image",
      mimeType: attachment.file.type || "application/octet-stream",
      size: attachment.file.size,
      contentBase64: await fileToBase64(attachment.file),
    })),
  );
}

export function revokeDraftPreview(attachment: DraftImageAttachment): void {
  if (attachment.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

function createPreviewUrl(file: File): string {
  if (typeof URL.createObjectURL !== "function") {
    return "";
  }
  return URL.createObjectURL(file);
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await readFileArrayBuffer(file));
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function readFileArrayBuffer(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") {
    return file.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
        return;
      }
      reject(new Error("Image file could not be read."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Image file could not be read."));
    });
    reader.readAsArrayBuffer(file);
  });
}
