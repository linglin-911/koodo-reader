import formats from "../main/annotation-backup-formats.json";

/** Never silently downgrade a newer/corrupt identity-aware manifest to v1. */
export const findAnnotationManifest = (names: string[]): string | undefined => {
  if (names.some(name => /^annotations\.v\d+\.json$/.test(name) && !formats.supported.includes(name)))
    throw new Error("Unsupported annotation backup version");
  return formats.supported.find(name => names.includes(name));
};
export const parseAnnotationManifest = (name: string, content: string): unknown => {
  const backup: unknown = JSON.parse(content);
  const version = Number(/\.v(\d+)\.json$/.exec(name)?.[1]);
  if (!formats.supported.includes(name) || !backup || typeof backup !== "object" ||
      !("version" in backup) || backup.version !== version)
    throw new Error("Annotation backup filename/version mismatch");
  return backup;
};
