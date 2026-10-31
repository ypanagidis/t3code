# T3 Code desktop app built from this checkout.
#
# The unpacked app (dist bundles plus the pnpm node_modules tree) runs on the
# nixpkgs Electron; electron-builder is not used. The bundled server runs under
# the same Electron binary with ELECTRON_RUN_AS_NODE, which is what node-pty and
# the other native addons load into.
#
# When pnpm-lock.yaml changes, nix/pnpm-deps.hash goes stale: run
# `nix build .#default.pnpmDeps` and put the "got:" hash from the mismatch error
# into that file. The nightly workflow does this on the `nightly` branch.
{
  lib,
  stdenv,
  callPackage,
  fetchPnpmDeps,
  pnpmConfigHook,
  pnpmBuildHook,
  pnpm_11,
  nodejs_24,
  electron_44,
  node-gyp,
  python3,
  pkg-config,
  libsecret,
  makeBinaryWrapper,
  copyDesktopItems,
  makeDesktopItem,
  spdx-license-list-data,

  # T3 Connect public client config, baked into the bundles at build time.
  # Leave null to build without T3 Connect sign-in.
  clerkPublishableKey ? null,
  clerkJwtTemplate ? null,
  clerkCliOAuthClientId ? null,
  relayUrl ? null,

  # Kept in its own file so the nightly workflow can refresh it after a merge.
  pnpmDepsHash ? lib.fileContents ./pnpm-deps.hash,
}:

let
  pnpm = pnpm_11;
  nodejs = nodejs_24;
  electron = electron_44;

  version = (lib.importJSON ../apps/desktop/package.json).version;

  # Only what the JS build reads. Excluding the Nix files keeps edits to them
  # from invalidating the dependency fetch and the build.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.difference ../. (
      lib.fileset.unions (
        map lib.fileset.maybeMissing [
          ../flake.nix
          ../flake.lock
          ../nix
          ../node_modules
          ../.t3
          ../.repos
          ../release
          ../.github
          ../docs
          ../apps/desktop/dist-electron
          ../apps/server/dist
          ../apps/web/dist
          ../native/browser-secret/build
          ../native/resource-monitor/target
          ../native/kde-snap-shot/target
          ../native/hyprland-snap-shot/target
        ]
      )
    );
  };

  nativeHelper = crate: callPackage ./native-helper.nix { inherit crate version; };
  resourceMonitor = nativeHelper "resource-monitor";
  kdeSnapShot = nativeHelper "kde-snap-shot";
  hyprlandSnapShot = nativeHelper "hyprland-snap-shot";

  publicConfig = lib.filterAttrs (_: value: value != null) {
    T3CODE_CLERK_PUBLISHABLE_KEY = clerkPublishableKey;
    T3CODE_CLERK_JWT_TEMPLATE = clerkJwtTemplate;
    T3CODE_CLERK_CLI_OAUTH_CLIENT_ID = clerkCliOAuthClientId;
    T3CODE_RELAY_URL = relayUrl;
  };

  appDir = "$out/libexec/t3code";
in
stdenv.mkDerivation (finalAttrs: {
  pname = "t3code";
  inherit version src;

  strictDeps = true;
  __structuredAttrs = true;

  env = publicConfig // {
    ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
  };

  # `...` pulls in each package's workspace dependencies. The mobile and
  # marketing apps are left out, which keeps the fetched store much smaller.
  pnpmWorkspaces = [
    "@t3tools/monorepo"
    "t3..."
    "@t3tools/web..."
    "@t3tools/desktop..."
    "@t3tools/scripts..."
  ];

  pnpmDeps = fetchPnpmDeps {
    inherit pnpm;
    inherit (finalAttrs)
      pname
      version
      src
      pnpmWorkspaces
      ;
    fetcherVersion = 4;
    hash = pnpmDepsHash;
  };

  nativeBuildInputs = [
    pnpmConfigHook
    pnpmBuildHook
    pnpm
    nodejs
    node-gyp
    python3
    pkg-config
    makeBinaryWrapper
    copyDesktopItems
  ];

  buildInputs = [ libsecret ];

  postPatch = ''
    # The web build embeds third-party license notices and otherwise downloads
    # the SPDX texts it needs.
    mkdir -p .generated/third-party-licenses/spdx/v3.28.0
    cp ${spdx-license-list-data.json}/json/details/*.json \
      .generated/third-party-licenses/spdx/v3.28.0
  '';

  preBuild = ''
    # pnpm 11 would otherwise re-verify the install before `pnpm run`.
    export pnpm_config_verify_deps_before_run=false

    # node-gyp builds against Node's headers instead of downloading them.
    export npm_config_nodedir=${nodejs}

    # Run the allowed install scripts that --ignore-scripts skipped. The root
    # `prepare` (effect-tsgo patch, vp config) only sets up editor tooling and
    # git hooks, so the root package is excluded.
    pnpm rebuild --pending "''${pnpmInstallFlags[@]}" --filter '!@t3tools/monorepo'

    # node-pty's prebuilt pty.node needs a libstdc++ that Electron does not
    # load, so build it from source like upstream's Linux release does. It is
    # an N-API addon, so the result also loads under Electron's Node.
    for pty in node_modules/.pnpm/node-pty@*/node_modules/node-pty; do
      (cd "$pty" && rm -rf prebuilds/linux-* && node-gyp rebuild)
    done
  '';

  pnpmBuildScript = "build:desktop";

  # Prebuilt platform binaries for other targets ship inside node_modules;
  # patchelf and the tmpdir audit choke on the static foreign ones.
  dontPatchELF = true;
  noAuditTmpdir = true;

  installPhase = ''
    runHook preInstall

    # Same layout as the checkout, which is where the unpackaged app looks for
    # the server bundle and its resources.
    mkdir -p ${appDir}/apps/desktop ${appDir}/apps/server
    # Keep modes: bundled helpers such as Cursor's ripgrep and node-pty's
    # spawn-helper must stay executable.
    cp -r node_modules ${appDir}/
    cp -r apps/server/{package.json,node_modules,dist} ${appDir}/apps/server/
    cp -r apps/desktop/{package.json,node_modules,dist-electron,gnome-extension} \
      ${appDir}/apps/desktop/
    chmod -R u+w ${appDir}

    resources=${appDir}/apps/desktop/prod-resources
    mkdir -p $resources
    install -m444 assets/prod/black-universal-1024.png $resources/icon.png
    install -Dm755 native/browser-secret/build/${stdenv.hostPlatform.node.arch}/t3-browser-secret \
      $resources/browser-secret/t3-browser-secret
    install -Dm755 ${lib.getExe resourceMonitor} \
      $resources/resource-monitor/t3-resource-monitor

    # Unpackaged builds look for the Linux capture helpers in their cargo
    # output directories.
    install -Dm755 ${lib.getExe kdeSnapShot} \
      ${appDir}/native/kde-snap-shot/target/release/t3-kde-snap-shot
    install -Dm755 ${lib.getExe hyprlandSnapShot} \
      ${appDir}/native/hyprland-snap-shot/target/release/t3-hyprland-snap-shot

    # pnpm leaves links to workspace packages and filtered-out optional deps.
    find ${appDir} -xtype l -delete

    makeWrapper ${lib.getExe electron} $out/bin/t3code \
      --add-flags ${appDir}/apps/desktop \
      --add-flags "\''${NIXOS_OZONE_WL:+\''${WAYLAND_DISPLAY:+--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations --enable-wayland-ime=true}}" \
      --set T3CODE_DISABLE_AUTO_UPDATE 1 \
      --inherit-argv0

    makeWrapper ${lib.getExe nodejs} $out/bin/t3 \
      --add-flags ${appDir}/apps/server/dist/bin.mjs

    install -Dm444 assets/prod/black-universal-1024.png \
      $out/share/icons/hicolor/1024x1024/apps/t3code.png
    install -Dm444 assets/prod/logo.svg \
      $out/share/icons/hicolor/scalable/apps/t3code.svg

    runHook postInstall
  '';

  desktopItems = [
    (makeDesktopItem {
      name = "t3code";
      desktopName = "T3 Code";
      comment = "Minimal GUI for coding agents";
      exec = "t3code %U";
      icon = "t3code";
      terminal = false;
      startupWMClass = "t3code";
      categories = [ "Development" ];
      mimeTypes = [ "x-scheme-handler/t3code" ];
    })
  ];

  passthru = {
    inherit resourceMonitor kdeSnapShot hyprlandSnapShot;
  };

  meta = {
    description = "Minimal GUI for coding agents";
    homepage = "https://t3.codes";
    license = lib.licenses.mit;
    mainProgram = "t3code";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
  };
})
