import { z } from "zod";

export const SessionParamsSchema = z.object({ id: z.string().min(1) });
export const ProjectParamsSchema = z.object({ id: z.string().min(1) });
export const RunnerParamsSchema = z.object({ id: z.string().min(1) });
export const ApprovalParamsSchema = z.object({ id: z.string().min(1) });

export const FileTreeQuerySchema = z.object({
  path: z.preprocess(
    (value) => (value === undefined || value === "" ? "." : value),
    z.string().min(1),
  ),
  depth: z.preprocess(
    (value) => (value === undefined || value === "" ? 3 : value),
    z.coerce.number().int().min(0).max(8),
  ),
});

export const FileContentQuerySchema = z.object({
  path: z.string().min(1),
  maxBytes: z.preprocess(
    (value) => (value === undefined || value === "" ? 256 * 1024 : value),
    z.coerce
      .number()
      .int()
      .positive()
      .max(1024 * 1024),
  ),
});

export const DirectoryCreateBodySchema = z.object({
  parentPath: z.string().min(1).default("."),
  name: z.string().min(1),
});
