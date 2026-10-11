// SPDX-License-Identifier: GPL-3.0
// Copyright (C) 2026 zmw
// 配置加载：默认 YAML + 可选用户覆盖（对象递归浅合并：顶层用户键覆盖默认键，对象属性合并而非整体替换）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof RegExp);
}

function mergeDefaults(def, user) {
  if (!isPlainObject(def) || !isPlainObject(user)) { return user === undefined ? def : user; }
  const out = { ...def };
  for (const key of Object.keys(user)) {
    out[key] = isPlainObject(def[key]) && isPlainObject(user[key]) ? mergeDefaults(def[key], user[key]) : user[key];
  }
  return out;
}

export function loadConfig(userPath) {
  const def = yaml.load(fs.readFileSync(path.join(ROOT, "config.default.yaml"), "utf8"));
  if (!userPath) { return def; }
  const user = yaml.load(fs.readFileSync(userPath, "utf8"));
  return mergeDefaults(def, user);
}
