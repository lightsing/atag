import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const webUrl = new URL(process.argv[2] ?? "");
if (!["http:", "https:"].includes(webUrl.protocol) || webUrl.username || webUrl.password) {
  throw new Error("Pass an HTTP or HTTPS ATAG website URL without credentials.");
}
const platform = { darwin: "macos", win32: "windows", linux: "linux" }[process.platform];
if (!platform) throw new Error(`Unsupported platform: ${process.platform}`);
const mac = platform === "macos";
const windows = platform === "windows";
const programs = ["atag-agent", "atag-agent-tray", "atag-coreadi-worker"];

const { target_directory: target, packages } = JSON.parse(
  execFileSync("cargo", ["metadata", "--locked", "--no-deps", "--format-version", "1"], {
    cwd: root,
    encoding: "utf8",
  }),
);
const { version } = packages.find(({ name }) => name === "atag-agent-tray");
function run(command, args, env = process.env) {
  execFileSync(command, args, { cwd: root, env, stdio: "inherit" });
}

const buildEnv = {
  ...process.env,
  ATAG_TRAY_WEB_URL: webUrl.href,
  CARGO_PROFILE_RELEASE_DEBUG: "0",
  CARGO_PROFILE_RELEASE_STRIP: "symbols",
};
if (windows) {
  const staticRuntime = "-Ctarget-feature=+crt-static";
  if (buildEnv.CARGO_ENCODED_RUSTFLAGS !== undefined) {
    buildEnv.CARGO_ENCODED_RUSTFLAGS = [buildEnv.CARGO_ENCODED_RUSTFLAGS, staticRuntime].filter(Boolean).join("\x1f");
  } else {
    buildEnv.RUSTFLAGS = [buildEnv.RUSTFLAGS, staticRuntime].filter(Boolean).join(" ");
  }
}
run("cargo", ["build", "--locked", "--release", ...programs.flatMap((name) => ["-p", name])], buildEnv);

const stage = mkdtempSync(join(tmpdir(), "atag-tray-"));
try {
  const name = mac ? "ATAG Agent.app" : "ATAG Agent";
  const bundle = join(stage, name);
  const bin = mac ? join(bundle, "Contents", "MacOS") : bundle;
  const resources = mac ? join(bundle, "Contents", "Resources") : bundle;
  mkdirSync(bin, { recursive: true });
  mkdirSync(resources, { recursive: true });

  for (const program of programs) {
    const file = program + (windows ? ".exe" : "");
    copyFileSync(join(target, "release", file), join(bin, file));
    if (mac) run("codesign", ["--force", "--sign", "-", join(bin, file)]);
  }
  copyFileSync(join(root, "tools/atag-coreadi-worker/LICENSE"), join(resources, "LICENSE-CoreADI-worker.txt"));
  writeFileSync(join(resources, "README.txt"), `ATAG Agent ${version}

打开 ${mac ? "ATAG Agent.app" : windows ? "atag-agent-tray.exe" : "atag-agent-tray"} 启动托盘。
本地 API 就绪后会在浏览器打开网页，网页会自动寻找本机 Agent。
托盘菜单中的“打开 ATAG 网页”可再次打开网页。
${webUrl.href}

首次使用默认的模拟 macOS 登录时，Agent 联网从 Apple 下载并校验 CoreADI 运行库，
然后自动注册机器身份。以后直接复用本地缓存。已有 Agent 数据目录可以继续使用。
${mac ? "CLI 位于 ATAG Agent.app/Contents/MacOS/。\n" : ""}`);

  if (mac) {
    const iconset = join(stage, "ATAG.iconset");
    const sourceIcon = join(root, "ios/ATAG/Assets.xcassets/AppIcon.appiconset/AppIcon.png");
    mkdirSync(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const pixels = String(size * scale);
        const icon = join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`);
        run("sips", ["-z", pixels, pixels, sourceIcon, "--out", icon]);
      }
    }
    run("iconutil", ["-c", "icns", "-o", join(resources, "ATAG.icns"), iconset]);
    writeFileSync(join(bundle, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>io.atag.agent-tray</string>
  <key>CFBundleName</key><string>ATAG Agent</string>
  <key>CFBundleExecutable</key><string>atag-agent-tray</string>
  <key>CFBundleIconFile</key><string>ATAG.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`);
    run("codesign", ["--force", "--sign", "-", bundle]);
    run("codesign", ["--verify", "--deep", "--strict", bundle]);
  }

  const packagesDir = join(target, "packages");
  mkdirSync(packagesDir, { recursive: true });
  const extension = platform === "linux" ? "tar.gz" : "zip";
  const file = `ATAG-Agent-${platform}-${process.arch}.${extension}`;
  const archive = join(stage, file);
  if (mac) run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", bundle, archive]);
  else if (windows) run("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "Compress-Archive -LiteralPath $env:ATAG_PACKAGE_SOURCE -DestinationPath $env:ATAG_PACKAGE_ARCHIVE -ErrorAction Stop",
  ], { ...process.env, ATAG_PACKAGE_SOURCE: bundle, ATAG_PACKAGE_ARCHIVE: archive });
  else run("tar", ["-czf", archive, "-C", stage, name]);
  copyFileSync(archive, join(packagesDir, file));
  console.log(join(packagesDir, file));
} finally {
  rmSync(stage, { recursive: true, force: true });
}
