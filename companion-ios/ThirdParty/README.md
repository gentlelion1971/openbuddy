# ThirdParty

This folder holds the TailscaleKit framework. It is **built from source, not
committed** (except the small marker files in this folder).

## What lives here after the build

- `TailscaleKit.xcframework` — the official TailscaleKit Swift framework,
  built from tailscale/libtailscale by `../scripts/build-tailscalekit.sh`.
  The Xcode project links and embeds this framework. Without it, Xcode
  fails at link time with "framework not found".
- `libtailscale-src/` — the shallow libtailscale clone the script used. It
  is kept so the `TailscaleKitHello` example
  (`swift/Examples/TailscaleKitHello/`) stays available for reference, and
  so the exact source the framework was built from can be inspected.
- `TAILSCALEKIT_VERSION` — the libtailscale commit the framework was built
  from (written by the build script).

## Build it

On the Mac, from the `companion-ios/` folder:

```sh
./scripts/build-tailscalekit.sh
```

Requires Go and Xcode 16.2+. See `../README.md` for the full build steps.

## Why not Swift Package Manager

TailscaleKit is not published as a Swift Package. The only supported way to
get it is to build the xcframework from source (`make ios-fat` in the
libtailscale repo), as Tailscale's own Aperture sample app does. Do not add
it as an SPM dependency; that does not exist.
