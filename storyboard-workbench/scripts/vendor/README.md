# ExcelJS 本地依赖

`exceljs.cjs` 为 ExcelJS 4.4.0 官方 npm 包中的 `dist/exceljs.min.js`，仅修改扩展名供 Node 加载。来自 https://registry.npmjs.org/exceljs/-/exceljs-4.4.0.tgz ，包完整性已按 npm 的 SHA-512 核对；版本及校验值见 `exceljs-source.json`。MIT 许可证见 `LICENSE-exceljs`，库内依赖的许可注释保留原样。

工作台在本地服务端使用该自包含构建写出真实 XLSX，不加载 CDN、不上传项目、无需用户运行 npm install。随 Skill 交接此目录。

官方项目与API文档：https://github.com/exceljs/exceljs/tree/v4.4.0 。本功能使用 Workbook、工作表列宽、字符串/数值单元格、自动换行、冻结首行与 `xlsx.writeBuffer()`，不把项目文本作为公式执行。
