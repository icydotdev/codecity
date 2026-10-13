import { expect, test } from "vitest";
import { readImports, resolveImports, type Spec } from "../src/imports.js";

/** Resolve one file's imports against a list of files that exist (path, or [path, lines]). */
function links(from: string, text: string, files: (string | [string, number])[], texts: Record<string, string> = {}): string[] {
  const specs = readImports(from, text) as Spec[];
  const known = { files: files.map((f) => (typeof f === "string" ? { path: f, lines: 10 } : { path: f[0], lines: f[1] })), read: (file: string) => texts[file] ?? null };
  return (resolveImports(new Map([[from, specs]]), known).get(from) ?? []).sort();
}

test("a language nobody reads has no imports, which is different from having none", () => {
  expect(readImports("notes.md", "import this")).toBeNull();
  expect(readImports("a.py", "x = 1")).toEqual([]);
});

test("python: absolute, relative, aliased and bracketed imports find their files", () => {
  const files = ["app/main.py", "app/util.py", "app/models/__init__.py", "app/models/user.py", "app/models/order.py", "src/lib/tools.py", "setup.py"];
  const text = `
import os, sys
import app.util as u
from app.models import user, order
from app.models import (
    user as U,  # the person
)
from . import util
from .models.user import User
from lib.tools import thing
from requests import get
`;
  expect(links("app/main.py", text, files)).toEqual(["app/models/order.py", "app/models/user.py", "app/util.py", "src/lib/tools.py"]);
  expect(links("app/models/user.py", "from .. import util\nfrom . import order\nfrom ..util import helper", files)).toEqual(["app/models/order.py", "app/util.py"]);
  expect(links("app/main.py", "from app import models", files), "a package is its __init__").toEqual(["app/models/__init__.py"]);
});

test("go: an import inside this module is one link, to the file that stands for the package", () => {
  const files: (string | [string, number])[] = ["go.mod", "main.go", ["internal/store/store.go", 40], ["internal/store/query.go", 400], ["internal/store/store_test.go", 900], ["pkg/api/handlers.go", 300], ["pkg/api/routes.go", 80]];
  const text = `package main

import (
	"fmt"
	st "example.com/shop/internal/store"
	"example.com/shop/pkg/api"
	"github.com/else/where"
)
import "example.com/shop/internal/store"
`;
  expect(links("main.go", text, files, { "go.mod": "module example.com/shop\n\ngo 1.22\n" })).toEqual(["internal/store/store.go", "pkg/api/handlers.go"]);
  expect(links("main.go", text, files), "without a go.mod nothing can be placed").toEqual([]);
});

test("rust: mod declarations and paths from crate, super and self", () => {
  const files = ["Cargo.toml", "src/main.rs", "src/config.rs", "src/net/mod.rs", "src/net/http.rs", "src/net/http/client.rs", "src/util.rs"];
  expect(links("src/main.rs", "mod config;\npub mod net;\nmod inline { }\nuse crate::net::http::Client;\nuse std::fmt;", files)).toEqual(["src/config.rs", "src/net/http.rs", "src/net/mod.rs"]);
  expect(links("src/net/http.rs", "mod client;\nuse super::super::util;\nuse super::Thing;\nuse crate::util::helper;", files), "a file's own modules are in the folder named after it").toEqual(["src/net/http/client.rs", "src/util.rs"]);
  expect(links("src/net/mod.rs", "pub mod http;\nuse self::http::Client;", files)).toEqual(["src/net/http.rs"]);
});

test("java and kotlin: a class is found by its package, wherever the source root is", () => {
  const files = ["app/src/main/java/com/shop/Order.java", "app/src/main/java/com/shop/util/Money.java", "core/src/main/kotlin/com/shop/core/Bus.kt"];
  const text = "package com.shop;\nimport com.shop.util.Money;\nimport static com.shop.util.Money.ZERO;\nimport com.shop.core.Bus\nimport com.shop.util.*;\nimport java.util.List;";
  expect(links("app/src/main/java/com/shop/Order.java", text, files)).toEqual(["app/src/main/java/com/shop/util/Money.java", "core/src/main/kotlin/com/shop/core/Bus.kt"]);
});

test("c and c++: quoted includes, beside the file or from an include root", () => {
  const files = ["src/main.c", "src/util.h", "include/lib/net.h", "src/sub/deep.c"];
  expect(links("src/main.c", '#include <stdio.h>\n#include "util.h"\n  #  include "lib/net.h"\n#include "missing.h"', files)).toEqual(["include/lib/net.h", "src/util.h"]);
  expect(links("src/sub/deep.c", '#include "../util.h"', files)).toEqual(["src/util.h"]);
});
