/** 注册 loader.mjs 里的解析钩子（--import 用；见该文件头部的说明） */
import { register } from "node:module";

register("./loader.mjs", import.meta.url);
