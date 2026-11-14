# One of the Rust sidecars under native/. Each crate has its own Cargo.lock, so
# no vendor hash is needed.
{
  lib,
  rustPlatform,
  crate,
  version,
}:

let
  root = ../native + "/${crate}";
in
rustPlatform.buildRustPackage {
  pname = "t3code-${crate}";
  inherit version;

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.difference root (lib.fileset.maybeMissing (root + "/target"));
  };

  cargoLock.lockFile = root + "/Cargo.lock";

  # The crates' tests need a live session bus or Wayland compositor.
  doCheck = false;

  meta.mainProgram = "t3-${crate}";
}
