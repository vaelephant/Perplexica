import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { Document } from '@langchain/core/documents';
import ModelRegistry from '@/lib/models/registry';
import { getFileType, isDocument } from '@/lib/utils/fileTypes';
import * as XLSX from 'xlsx';

interface FileRes {
  fileName: string;
  fileExtension: string;
  fileId: string;
  fileType?: 'document' | 'image' | 'other';
}

const uploadDir = path.join(process.cwd(), 'uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 500,
  chunkOverlap: 100,
});

export async function POST(req: Request) {
  try {
    console.log('[UPLOAD] ===== 开始处理文件上传 =====');
    const formData = await req.formData();

    const files = formData.getAll('files') as File[];
    const embedding_model = formData.get('embedding_model_key') as string;
    const embedding_model_provider = formData.get('embedding_model_provider_id') as string;

    console.log('[UPLOAD] 上传文件数量:', files.length);
    console.log('[UPLOAD] Embedding Model:', embedding_model ? '已提供' : '未提供');
    console.log('[UPLOAD] Embedding Provider:', embedding_model_provider ? '已提供' : '未提供');

    const processedFiles: FileRes[] = [];

    // 检查是否有文档类型的文件，如果有则需要 embedding model
    const hasDocumentFiles = files.some((file: any) => {
      const fileExtension = file.name.split('.').pop()?.toLowerCase();
      return fileExtension && isDocument(fileExtension);
    });

    console.log('[UPLOAD] 是否有文档文件:', hasDocumentFiles);

    if (hasDocumentFiles && (!embedding_model || !embedding_model_provider)) {
      console.error('[UPLOAD] 错误: 文档文件需要 embedding model，但未提供');
      return NextResponse.json(
        { message: 'Missing embedding model or provider for document files' },
        { status: 400 },
      );
    }

    // 只有存在文档文件时才加载 embedding model
    let model: any = null;
    if (hasDocumentFiles && embedding_model && embedding_model_provider) {
      console.log('[UPLOAD] 加载 Embedding Model...');
      const registry = new ModelRegistry();
      model = await registry.loadEmbeddingModel(embedding_model_provider, embedding_model);
      console.log('[UPLOAD] Embedding Model 加载成功');
    } else if (hasDocumentFiles) {
      console.warn('[UPLOAD] 警告: 有文档文件但没有提供 embedding model，文档将不会被处理');
    }

    await Promise.all(
      files.map(async (file: any) => {
        const fileExtension = file.name.split('.').pop()?.toLowerCase();
        if (!fileExtension) {
          console.warn('[UPLOAD] 警告: 文件没有扩展名:', file.name);
          return;
        }

        const fileType = getFileType(fileExtension);
        const uniqueFileName = `${crypto.randomBytes(16).toString('hex')}.${fileExtension}`;
        const filePath = path.join(uploadDir, uniqueFileName);
        const fileId = uniqueFileName.replace(/\.\w+$/, '');

        console.log(`[UPLOAD] 处理文件: ${file.name}`);
        console.log(`[UPLOAD]   类型: ${fileType}`);
        console.log(`[UPLOAD]   扩展名: ${fileExtension}`);
        console.log(`[UPLOAD]   文件ID: ${fileId}`);
        console.log(`[UPLOAD]   保存路径: ${filePath}`);

        // 保存文件
        const buffer = Buffer.from(await file.arrayBuffer());
        fs.writeFileSync(filePath, new Uint8Array(buffer));
        console.log(`[UPLOAD]   文件已保存: ${filePath}`);

        // 只对文档类型进行文本提取和向量化
        if (fileType === 'document' && model) {
          console.log(`[UPLOAD]   开始处理文档: ${fileType} 类型`);
          let docs: any[] = [];
          
          try {
            if (fileExtension === 'pdf') {
              console.log(`[UPLOAD]   使用 PDFLoader 加载 PDF 文件...`);
              const loader = new PDFLoader(filePath);
              docs = await loader.load();
              console.log(`[UPLOAD]   PDF 加载成功，共 ${docs.length} 页`);
            } else if (fileExtension === 'docx') {
              console.log(`[UPLOAD]   使用 DocxLoader 加载 DOCX 文件...`);
              const loader = new DocxLoader(filePath);
              docs = await loader.load();
              console.log(`[UPLOAD]   DOCX 加载成功，共 ${docs.length} 个文档块`);
            } else if (fileExtension === 'txt') {
              console.log(`[UPLOAD]   读取 TXT 文件...`);
              const text = fs.readFileSync(filePath, 'utf-8');
              docs = [
                new Document({ pageContent: text, metadata: { title: file.name } }),
              ];
              console.log(`[UPLOAD]   TXT 读取成功，内容长度: ${text.length} 字符`);
            } else if (fileExtension === 'xlsx' || fileExtension === 'xls') {
              console.log(`[UPLOAD]   使用 XLSX 解析 Excel 文件...`);
              // 使用 buffer 而不是文件路径，避免文件访问问题
              const workbook = XLSX.read(buffer, { type: 'buffer' });
              const allSheetData: string[] = [];
              
              console.log(`[UPLOAD]   Excel 文件解析成功，工作表数: ${workbook.SheetNames.length}`);
              console.log(`[UPLOAD]   工作表列表: ${workbook.SheetNames.join(', ')}`);
              
              workbook.SheetNames.forEach((sheetName) => {
                const worksheet = workbook.Sheets[sheetName];
                const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
                
                console.log(`[UPLOAD]   处理工作表 "${sheetName}"，行数: ${jsonData.length}`);
                
                // 将每行数据转换为文本格式
                jsonData.forEach((row: any, rowIndex: number) => {
                  const rowText = Array.isArray(row) 
                    ? row.filter(cell => cell !== null && cell !== undefined && cell !== '').join(' | ')
                    : JSON.stringify(row);
                  if (rowText.trim()) {
                    allSheetData.push(`工作表 "${sheetName}" 第${rowIndex + 1}行: ${rowText}`);
                  }
                });
              });
              
              if (allSheetData.length > 0) {
                docs = [
                  new Document({
                    pageContent: allSheetData.join('\n'),
                    metadata: {
                      title: file.name,
                      sheetCount: workbook.SheetNames.length,
                      sheetNames: workbook.SheetNames.join(', '),
                    },
                  }),
                ];
                console.log(`[UPLOAD]   Excel 加载成功，工作表数: ${workbook.SheetNames.length}，数据行数: ${allSheetData.length}`);
                console.log(`[UPLOAD]   提取的内容预览（前500字符）: ${allSheetData.slice(0, 3).join('\n')}...`);
              } else {
                console.warn(`[UPLOAD]   警告: Excel 文件 ${file.name} 没有数据`);
              }
            }

            console.log(`[UPLOAD]   开始分割文档，原始块数: ${docs.length}`);
            const splitted = await splitter.splitDocuments(docs);
            console.log(`[UPLOAD]   文档分割完成，分割后块数: ${splitted.length}`);

            const extractedDataPath = filePath.replace(/\.\w+$/, '-extracted.json');
            const extractedData = {
              title: file.name,
              contents: splitted.map((doc) => doc.pageContent),
            };
            fs.writeFileSync(extractedDataPath, JSON.stringify(extractedData, null, 2));
            console.log(`[UPLOAD]   提取的内容已保存: ${extractedDataPath}`);
            console.log(`[UPLOAD]   内容块数量: ${extractedData.contents.length}`);

            console.log(`[UPLOAD]   开始生成嵌入向量...`);
            const embeddings = await model.embedDocuments(
              splitted.map((doc) => doc.pageContent),
            );
            console.log(`[UPLOAD]   嵌入向量生成完成，向量数量: ${embeddings.length}`);
            
            const embeddingsDataPath = filePath.replace(/\.\w+$/, '-embeddings.json');
            fs.writeFileSync(
              embeddingsDataPath,
              JSON.stringify({
                title: file.name,
                embeddings,
              }, null, 2),
            );
            console.log(`[UPLOAD]   嵌入向量已保存: ${embeddingsDataPath}`);
            console.log(`[UPLOAD]   文档处理完成: ${file.name}`);
          } catch (error) {
            console.error(`[UPLOAD]   文档处理失败: ${file.name}`, error);
            throw error;
          }
        } else if (fileType === 'document' && !model) {
          console.warn(`[UPLOAD]   警告: 文档文件 ${file.name} 需要 embedding model，但未提供，跳过处理`);
        } else {
          console.log(`[UPLOAD]   文件类型 ${fileType}，跳过文档处理（仅保存文件）`);
        }

        processedFiles.push({
          fileName: file.name,
          fileExtension: fileExtension,
          fileId: fileId,
          fileType: fileType,
        });

        console.log(`[UPLOAD]   文件处理完成: ${file.name} -> fileId: ${fileId}`);
      }),
    );

    console.log('[UPLOAD] ===== 所有文件处理完成 =====');
    console.log('[UPLOAD] 返回文件列表:', processedFiles.map(f => ({ name: f.fileName, id: f.fileId, type: f.fileType })));

    return NextResponse.json({
      files: processedFiles,
    });
  } catch (error) {
    console.error('[UPLOAD] ===== 文件上传失败 =====');
    console.error('[UPLOAD] 错误详情:', error);
    if (error instanceof Error) {
      console.error('[UPLOAD] 错误堆栈:', error.stack);
    }
    return NextResponse.json(
      { message: 'An error has occurred.' },
      { status: 500 },
    );
  }
}
