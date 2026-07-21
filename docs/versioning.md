# Versioning

Five public packages share one package version and use exact internal package
dependencies. Package semver, `.avl` wire version, and compiler-project version
are independent:

| Space | Technical-preview value |
| --- | --- |
| Public packages | `1.0.0` |
| Compiled wire format | `1.1` |
| Compiler project | `1.0` |

All public APIs are experimental during technical preview. The repository does
not preserve earlier package APIs or wire readers; consumers must pin an exact
preview release. A stable compatibility policy will be defined before the first
stable release.
