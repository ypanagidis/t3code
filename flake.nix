{
  description = "T3 Code desktop app, built from source";

  # The nightly workflow builds the `nightly` branch (github:ypanagidis/t3code/nightly) and pushes
  # the package here. The cache is private: reading it needs an attic token with pull access in a
  # netrc file (`machine cache.nix.devminer.xyz password <token>`, set via `netrc-file`). Applied for
  # `nix build` and `nix run` on this flake after accepting it; as a NixOS input, add both lines and
  # `netrc-file` to `nix.settings` instead.
  nixConfig = {
    extra-substituters = [ "https://cache.nix.devminer.xyz/ypanagidis-t3code" ];
    extra-trusted-public-keys = [
      "ypanagidis-t3code:biaVNFvZxaboN0Cnld1r8E1E4qBcyDJc2zfKJ8uXbM4="
    ];
  };

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      overlays.default = final: _prev: {
        t3code = final.callPackage ./nix/package.nix { };
      };

      packages = forAllSystems (
        pkgs:
        let
          t3code = pkgs.callPackage ./nix/package.nix { };
        in
        {
          inherit t3code;
          default = t3code;
        }
      );

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_24
            pnpm_11
            python3
            pkg-config
            libsecret
            cargo
            rustc
            imagemagick
            git
          ];
          # The electron npm package cannot run its downloaded binary on NixOS;
          # point it at the nixpkgs build instead.
          ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
          ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron_44}/libexec/electron";
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
