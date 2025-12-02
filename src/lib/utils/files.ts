import path from 'path';
import fs from 'fs';

export const getFileDetails = (fileId: string) => {
  console.log(`[FILE_DETAILS] 获取文件详情: ${fileId}`);
  
  const extractedFileLoc = path.join(
    process.cwd(),
    './uploads',
    fileId + '-extracted.json',
  );

  console.log(`[FILE_DETAILS] 检查提取文件: ${extractedFileLoc}`);

  // 如果是文档文件，尝试读取提取的内容
  if (fs.existsSync(extractedFileLoc)) {
    try {
      console.log(`[FILE_DETAILS] 提取文件存在，读取中...`);
      const parsedFile = JSON.parse(fs.readFileSync(extractedFileLoc, 'utf8'));
      console.log(`[FILE_DETAILS] 文件详情获取成功: ${parsedFile.title}`);
      return {
        name: parsedFile.title,
        fileId: fileId,
      };
    } catch (error) {
      console.warn(`[FILE_DETAILS] 读取提取文件失败 ${fileId}:`, error);
    }
  } else {
    console.log(`[FILE_DETAILS] 提取文件不存在，可能是非文档文件`);
  }

  // 对于非文档文件（如图片），尝试从上传目录中找到原始文件
  const uploadDir = path.join(process.cwd(), 'uploads');
  if (fs.existsSync(uploadDir)) {
    console.log(`[FILE_DETAILS] 在上传目录中查找原始文件...`);
    const files = fs.readdirSync(uploadDir);
    const originalFile = files.find((f) => f.startsWith(fileId) && !f.includes('-extracted') && !f.includes('-embeddings'));
    
    if (originalFile) {
      console.log(`[FILE_DETAILS] 找到原始文件: ${originalFile}`);
      return {
        name: originalFile,
        fileId: fileId,
      };
    } else {
      console.log(`[FILE_DETAILS] 未找到原始文件，文件ID: ${fileId}`);
    }
  } else {
    console.warn(`[FILE_DETAILS] 上传目录不存在: ${uploadDir}`);
  }

  // 如果都找不到，返回基本信息
  console.log(`[FILE_DETAILS] 使用文件ID作为名称: ${fileId}`);
  return {
    name: fileId,
    fileId: fileId,
  };
};
