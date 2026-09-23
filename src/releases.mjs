// Published APKs only. No arbitrary download names, directories or query strings.
export const isApkPath = pathname => /^\/downloads\/CodexLink-[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}\.apk$/.test(pathname);
