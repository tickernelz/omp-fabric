let bundledLanguageIds: ReadonlySet<string> | undefined;
let loadingLanguageIds: Promise<ReadonlySet<string>> | undefined;

export const languageIdsLoaded = (): ReadonlySet<string> | undefined => bundledLanguageIds;

export const loadLanguageIds = (): Promise<ReadonlySet<string>> => {
  if (bundledLanguageIds) return Promise.resolve(bundledLanguageIds);
  loadingLanguageIds ??= import("shiki/langs").then((module) => {
    bundledLanguageIds = new Set(Object.keys(module.bundledLanguages));
    return bundledLanguageIds;
  });
  return loadingLanguageIds;
};
