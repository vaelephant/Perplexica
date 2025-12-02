# Excel 文件处理修复说明

## 问题

错误日志显示：
```
Error: Cannot access file /Users/yzm/code/Perplexica/uploads/dd0d8b3e7f9bb64fb1be5a2de8cccfd8.xlsx
    at XLSX.readFile(filePath)
```

## 原因

`XLSX.readFile()` 方法需要从文件系统读取文件，但在 Next.js 环境中可能存在文件访问限制或路径问题。

## 解决方案

改为使用 `XLSX.read()` 方法，直接从已经读取的 buffer 解析，而不是从文件路径读取。

### 修改前（有问题）
```typescript
const workbook = XLSX.readFile(filePath);
```

### 修改后（正确）
```typescript
const buffer = Buffer.from(await file.arrayBuffer());
// ... 保存文件 ...
const workbook = XLSX.read(buffer, { type: 'buffer' });
```

## 优势

1. **不依赖文件系统**：直接从内存中的 buffer 读取，更可靠
2. **更快**：不需要再次读取磁盘文件
3. **更安全**：避免文件路径和权限问题

## 如何生效

代码已经修复，但您看到的错误日志可能是服务器还在使用旧代码。

### 解决方法

1. **重启开发服务器**：
   ```bash
   # 停止当前服务器 (Ctrl+C)
   # 然后重新启动
   npm run dev
   ```

2. **清除 Next.js 缓存**（如果重启还不行）：
   ```bash
   rm -rf .next
   npm run dev
   ```

3. **检查代码是否已更新**：
   确认 `src/app/api/uploads/route.ts` 第123行使用的是：
   ```typescript
   const workbook = XLSX.read(buffer, { type: 'buffer' });
   ```
   而不是：
   ```typescript
   const workbook = XLSX.readFile(filePath);
   ```

## 验证

重启后，重新上传 Excel 文件，应该看到类似的日志：

```
[UPLOAD]   使用 XLSX 解析 Excel 文件（从 buffer）...
[UPLOAD]   Excel 文件解析成功，工作表数: X
[UPLOAD]   工作表列表: Sheet1, Sheet2
[UPLOAD]   处理工作表 "Sheet1"，行数: X
[UPLOAD]   Excel 加载成功，工作表数: X，数据行数: X
```

---

**修复日期**：2025-12-02
**状态**：✅ 已修复（需要重启服务器生效）

