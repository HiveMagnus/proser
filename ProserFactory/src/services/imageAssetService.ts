import { assertReleaseMutation } from "@/operations/releaseAdmission";
import { databaseService } from "../lib/database";
import logger from "../lib/logger";
import type { ImageAsset } from "@prisma/client";
import fs from "fs/promises";
import path from "path";
import { inspectImageMetadata } from "@/lib/imageMetadata";
import { ValidationError } from "../lib/errors";

/** Extract a filename from a URL path. */
function urlToName(url: string): string {
  try {
    const u = new URL(url, "http://localhost");
    const parts = u.pathname.split("/");
    return parts[parts.length - 1] || u.pathname;
  } catch {
    const m = url.match(/\/images\/(.+)$/);
    return m ? m[1] : url.split("/").pop() || url;
  }
}

class ImageAssetService {
  /**
   * Persist generated image URLs as ImageAsset rows.
   * Returns the created rows so callers can expose protected asset URLs.
   */
  async persistAssets(opts: {
    userId: number;
    bookId?: number;
    urls: string[];
    source: "forge" | "flux" | "release-fixture";
    config?: Record<string, unknown>;
  }): Promise<ImageAsset[]> {
    try {
      if (!opts.urls.length) return [];
      if (!databaseService.isReady) throw new Error("Database is unavailable");
      const prepared = await Promise.all(
        opts.urls.map(async (url) => {
          const name = urlToName(url);
          if (!name || path.basename(name) !== name)
            throw new ValidationError("Invalid generated image filename");
          const root = path.resolve("public/images");
          const filePath = path.resolve(root, name);
          const stat = await fs.lstat(filePath);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            !stat.size ||
            stat.size > 32 * 1024 * 1024
          )
            throw new ValidationError(
              "Generated image is not a bounded local file",
            );
          const bytes = await fs.readFile(filePath);
          const verified = inspectImageMetadata(bytes);
          return {
            name,
            url,
            configJson: JSON.stringify({ ...opts.config, ...verified }),
          };
        }),
      );
      return await databaseService.client.$transaction(async (tx) => {
        await assertReleaseMutation(tx, `assets:${opts.bookId ?? "user"}`);
        return Promise.all(
          prepared.map((asset) =>
            tx.imageAsset.create({
              data: {
                userId: opts.userId,
                bookId: opts.bookId ?? null,
                name: asset.name,
                url: asset.url,
                source: opts.source,
                configJson: asset.configJson,
              },
            }),
          ),
        );
      });
    } catch (err) {
      logger.error(
        { err, userId: opts.userId, source: opts.source },
        "Failed to persist image assets",
      );
      // A failed registration cannot authorize deleting potentially shared
      // bytes. All rows roll back together; retained files can be reconciled.
      throw err;
    }
  }
}

export const imageAssetService = new ImageAssetService();
