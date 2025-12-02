import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Embeddings } from '@langchain/core/embeddings';
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
  PromptTemplate,
} from '@langchain/core/prompts';
import {
  RunnableLambda,
  RunnableMap,
  RunnableSequence,
} from '@langchain/core/runnables';
import { BaseMessage, BaseMessageLike } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';
import LineListOutputParser from '../outputParsers/listLineOutputParser';
import LineOutputParser from '../outputParsers/lineOutputParser';
import { getDocumentsFromLinks } from '../utils/documents';
import { Document } from '@langchain/core/documents';
import { searchSearxng } from '../searxng';
import path from 'node:path';
import fs from 'node:fs';
import computeSimilarity from '../utils/computeSimilarity';
import formatChatHistoryAsString from '../utils/formatHistory';
import eventEmitter from 'events';
import { StreamEvent } from '@langchain/core/tracers/log_stream';

export interface MetaSearchAgentType {
  searchAndAnswer: (
    message: string,
    history: BaseMessage[],
    llm: BaseChatModel,
    embeddings: Embeddings,
    optimizationMode: 'speed' | 'balanced' | 'quality',
    fileIds: string[],
    systemInstructions: string,
  ) => Promise<eventEmitter>;
}

interface Config {
  searchWeb: boolean;
  rerank: boolean;
  rerankThreshold: number;
  queryGeneratorPrompt: string;
  queryGeneratorFewShots: BaseMessageLike[];
  responsePrompt: string;
  activeEngines: string[];
}

type BasicChainInput = {
  chat_history: BaseMessage[];
  query: string;
};

class MetaSearchAgent implements MetaSearchAgentType {
  private config: Config;
  private strParser = new StringOutputParser();

  constructor(config: Config) {
    this.config = config;
  }

  private async createSearchRetrieverChain(llm: BaseChatModel) {
    console.log('[LLM] ===== 创建搜索检索链 =====');
    (llm as unknown as ChatOpenAI).temperature = 0;
    console.log('[LLM] 设置搜索检索链 LLM 温度为 0');

    return RunnableSequence.from([
      ChatPromptTemplate.fromMessages([
        ['system', this.config.queryGeneratorPrompt],
        ...this.config.queryGeneratorFewShots,
        [
          'user',
          `
        <conversation>
        {chat_history}
        </conversation>

        <query>
        {query}
        </query>
       `,
        ],
      ]),
      llm,
      this.strParser,
      RunnableLambda.from(async (input: string) => {
        console.log('[LLM] ===== 处理搜索检索链 LLM 输出 =====');
        console.log('[LLM] LLM 输出长度:', input.length);
        const parseStartTime = Date.now();
        
        const linksOutputParser = new LineListOutputParser({
          key: 'links',
        });

        const questionOutputParser = new LineOutputParser({
          key: 'question',
        });

        const links = await linksOutputParser.parse(input);
        let question = (await questionOutputParser.parse(input)) ?? input;
        
        console.log('[LLM] 解析完成，链接数量:', links.length);
        console.log('[LLM] 提取的问题:', question.substring(0, 100) + '...');
        console.log(`[LLM] 解析耗时: ${Date.now() - parseStartTime}ms`);

        if (question === 'not_needed') {
          return { query: '', docs: [] };
        }

        if (links.length > 0) {
          if (question.length === 0) {
            question = 'summarize';
          }

          let docs: Document[] = [];

          const linkDocs = await getDocumentsFromLinks({ links });

          const docGroups: Document[] = [];

          linkDocs.map((doc) => {
            const URLDocExists = docGroups.find(
              (d) =>
                d.metadata.url === doc.metadata.url &&
                d.metadata.totalDocs < 10,
            );

            if (!URLDocExists) {
              docGroups.push({
                ...doc,
                metadata: {
                  ...doc.metadata,
                  totalDocs: 1,
                },
              });
            }

            const docIndex = docGroups.findIndex(
              (d) =>
                d.metadata.url === doc.metadata.url &&
                d.metadata.totalDocs < 10,
            );

            if (docIndex !== -1) {
              docGroups[docIndex].pageContent =
                docGroups[docIndex].pageContent + `\n\n` + doc.pageContent;
              docGroups[docIndex].metadata.totalDocs += 1;
            }
          });

          console.log('[LLM] 开始批量调用 LLM 进行文档摘要，文档数量:', docGroups.length);
          const summarizeStartTime = Date.now();
          await Promise.all(
            docGroups.map(async (doc, index) => {
              const docStartTime = Date.now();
              console.log(`[LLM] [${index + 1}/${docGroups.length}] 开始摘要文档: ${doc.metadata.title || doc.metadata.url}`);
              const res = await llm.invoke(`
            You are a web search summarizer, tasked with summarizing a piece of text retrieved from a web search. Your job is to summarize the 
            text into a detailed, 2-4 paragraph explanation that captures the main ideas and provides a comprehensive answer to the query.
            If the query is \"summarize\", you should provide a detailed summary of the text. If the query is a specific question, you should answer it in the summary.
            
            - **Journalistic tone**: The summary should sound professional and journalistic, not too casual or vague.
            - **Thorough and detailed**: Ensure that every key point from the text is captured and that the summary directly answers the query.
            - **Not too lengthy, but detailed**: The summary should be informative but not excessively long. Focus on providing detailed information in a concise format.

            The text will be shared inside the \`text\` XML tag, and the query inside the \`query\` XML tag.

            <example>
            1. \`<text>
            Docker is a set of platform-as-a-service products that use OS-level virtualization to deliver software in packages called containers. 
            It was first released in 2013 and is developed by Docker, Inc. Docker is designed to make it easier to create, deploy, and run applications 
            by using containers.
            </text>

            <query>
            What is Docker and how does it work?
            </query>

            Response:
            Docker is a revolutionary platform-as-a-service product developed by Docker, Inc., that uses container technology to make application 
            deployment more efficient. It allows developers to package their software with all necessary dependencies, making it easier to run in 
            any environment. Released in 2013, Docker has transformed the way applications are built, deployed, and managed.
            \`
            2. \`<text>
            The theory of relativity, or simply relativity, encompasses two interrelated theories of Albert Einstein: special relativity and general
            relativity. However, the word "relativity" is sometimes used in reference to Galilean invariance. The term "theory of relativity" was based
            on the expression "relative theory" used by Max Planck in 1906. The theory of relativity usually encompasses two interrelated theories by
            Albert Einstein: special relativity and general relativity. Special relativity applies to all physical phenomena in the absence of gravity.
            General relativity explains the law of gravitation and its relation to other forces of nature. It applies to the cosmological and astrophysical
            realm, including astronomy.
            </text>

            <query>
            summarize
            </query>

            Response:
            The theory of relativity, developed by Albert Einstein, encompasses two main theories: special relativity and general relativity. Special
            relativity applies to all physical phenomena in the absence of gravity, while general relativity explains the law of gravitation and its
            relation to other forces of nature. The theory of relativity is based on the concept of "relative theory," as introduced by Max Planck in
            1906. It is a fundamental theory in physics that has revolutionized our understanding of the universe.
            \`
            </example>

            Everything below is the actual data you will be working with. Good luck!

            <query>
            ${question}
            </query>

            <text>
            ${doc.pageContent}
            </text>

            Make sure to answer the query in the summary.
          `);

              const document = new Document({
                pageContent: res.content as string,
                metadata: {
                  title: doc.metadata.title,
                  url: doc.metadata.url,
                },
              });

              const docDuration = Date.now() - docStartTime;
              console.log(`[LLM] [${index + 1}/${docGroups.length}] 文档摘要完成（耗时: ${docDuration}ms），摘要长度: ${(res.content as string).length} 字符`);
              docs.push(document);
            }),
          );
          const summarizeDuration = Date.now() - summarizeStartTime;
          console.log(`[LLM] 所有文档摘要完成（总耗时: ${summarizeDuration}ms），摘要文档数: ${docs.length}`);

          return { query: question, docs: docs };
        } else {
          question = question.replace(/<think>.*?<\/think>/g, '');

          const res = await searchSearxng(question, {
            language: 'en',
            engines: this.config.activeEngines,
          });

          const documents = res.results.map(
            (result) =>
              new Document({
                pageContent:
                  result.content ||
                  (this.config.activeEngines.includes('youtube')
                    ? result.title
                    : '') /* Todo: Implement transcript grabbing using Youtubei (source: https://www.npmjs.com/package/youtubei) */,
                metadata: {
                  title: result.title,
                  url: result.url,
                  ...(result.img_src && { img_src: result.img_src }),
                },
              }),
          );

          return { query: question, docs: documents };
        }
      }),
    ]);
  }

  private async createAnsweringChain(
    llm: BaseChatModel,
    fileIds: string[],
    embeddings: Embeddings,
    optimizationMode: 'speed' | 'balanced' | 'quality',
    systemInstructions: string,
  ) {
    return RunnableSequence.from([
      RunnableMap.from({
        systemInstructions: () => systemInstructions,
        query: (input: BasicChainInput) => input.query,
        chat_history: (input: BasicChainInput) => input.chat_history,
        date: () => new Date().toISOString(),
        context: RunnableLambda.from(async (input: BasicChainInput) => {
          console.log('[CONTEXT] ===== 开始构建上下文 =====');
          console.log('[CONTEXT] 查询:', input.query);
          console.log('[CONTEXT] 文件ID:', fileIds);
          console.log('[CONTEXT] 是否搜索网络:', this.config.searchWeb);

          const processedHistory = formatChatHistoryAsString(
            input.chat_history,
          );

          let docs: Document[] | null = null;
          let query = input.query;

          if (this.config.searchWeb) {
            console.log('[CONTEXT] 执行网络搜索...');
            const searchRetrieverChain =
              await this.createSearchRetrieverChain(llm);

            console.log('[LLM] 调用搜索检索链 LLM...');
            const searchInvokeStartTime = Date.now();
            const searchRetrieverResult = await searchRetrieverChain.invoke({
              chat_history: processedHistory,
              query,
            });
            console.log(`[LLM] 搜索检索链 LLM 调用完成（耗时: ${Date.now() - searchInvokeStartTime}ms）`);

            query = searchRetrieverResult.query;
            docs = searchRetrieverResult.docs;
            console.log('[CONTEXT] 网络搜索结果，文档数量:', docs?.length || 0);
          } else {
            console.log('[CONTEXT] 跳过网络搜索');
          }

          console.log('[CONTEXT] 开始重新排序文档...');
          const sortedDocs = await this.rerankDocs(
            query,
            docs ?? [],
            fileIds,
            embeddings,
            optimizationMode,
          );

          console.log('[CONTEXT] 重新排序完成，返回文档数量:', sortedDocs.length);
          console.log('[CONTEXT] ===== 上下文构建完成 =====');
          return { docs: sortedDocs, fileIds };
        })
          .withConfig({
            runName: 'FinalSourceRetriever',
          })
          .pipe((input: { docs: Document[]; fileIds: string[] }) =>
            this.processDocs(input.docs, input.fileIds),
          ),
      }),
      ChatPromptTemplate.fromMessages([
        ['system', this.config.responsePrompt],
        new MessagesPlaceholder('chat_history'),
        ['user', '{query}'],
      ]),
      RunnableLambda.from(async (messages: any) => {
        console.log('[LLM] ===== 准备调用 LLM 生成最终响应 =====');
        console.log('[LLM] Prompt 消息数量:', messages.length);
        if (Array.isArray(messages) && messages.length > 0) {
          console.log('[LLM] 最后一条用户消息预览:', 
            typeof messages[messages.length - 1]?.content === 'string' 
              ? messages[messages.length - 1].content.substring(0, 200) + '...'
              : '非字符串内容'
          );
        }
        const responseStartTime = Date.now();
        console.log('[LLM] 开始调用 LLM...');
        // 返回消息以便后续的 llm 处理
        return messages;
      }),
      llm,
      this.strParser,
    ]).withConfig({
      runName: 'FinalResponseGenerator',
    });
  }

  private async rerankDocs(
    query: string,
    docs: Document[],
    fileIds: string[],
    embeddings: Embeddings,
    optimizationMode: 'speed' | 'balanced' | 'quality',
  ) {
    console.log('[RERANK] ===== 开始处理文件内容 =====');
    console.log('[RERANK] 接收到的 fileIds:', fileIds);
    console.log('[RERANK] 接收到的 docs 数量:', docs.length);
    console.log('[RERANK] 查询内容:', query.substring(0, 100) + '...');
    console.log('[RERANK] 当前工作目录:', process.cwd());
    console.log('[RERANK] uploads 目录路径:', path.join(process.cwd(), 'uploads'));

    // 如果没有文档和文件ID，直接返回，避免不必要的处理
    if (docs.length === 0 && fileIds.length === 0) {
      console.log('[RERANK] 没有文档和文件ID，直接返回空数组');
      return docs;
    }

    // 如果只有文件ID但没有文档，检查文件是否已处理
    if (docs.length === 0 && fileIds.length > 0) {
      console.log('[RERANK] 只有文件ID，没有搜索文档，继续处理文件内容...');
    }

    if (fileIds.length === 0) {
      console.log('[RERANK] 没有文件ID，仅处理搜索文档');
    }

    const filesData = fileIds
      .map((file) => {
        console.log(`[RERANK] 处理文件ID: ${file}`);
        const filePath = path.join(process.cwd(), 'uploads', file);

        const contentPath = filePath + '-extracted.json';
        const embeddingsPath = filePath + '-embeddings.json';

        console.log(`[RERANK]   查找路径: ${filePath}`);
        console.log(`[RERANK]   完整内容文件路径: ${contentPath}`);
        console.log(`[RERANK]   完整向量文件路径: ${embeddingsPath}`);
        console.log(`[RERANK]   内容文件存在: ${fs.existsSync(contentPath)}`);
        console.log(`[RERANK]   向量文件存在: ${fs.existsSync(embeddingsPath)}`);
        
        // 如果文件不存在，列出 uploads 目录中的文件以便调试
        if (!fs.existsSync(contentPath) || !fs.existsSync(embeddingsPath)) {
          const uploadDir = path.join(process.cwd(), 'uploads');
          if (fs.existsSync(uploadDir)) {
            const allFiles = fs.readdirSync(uploadDir);
            const matchingFiles = allFiles.filter(f => f.startsWith(file));
            console.log(`[RERANK]   文件未找到，尝试匹配...`);
            console.log(`[RERANK]   当前文件ID: ${file}`);
            console.log(`[RERANK]   文件ID长度: ${file.length}`);
            console.log(`[RERANK]   uploads 目录中所有文件数量: ${allFiles.length}`);
            console.log(`[RERANK]   uploads 目录中以 "${file}" 开头的文件:`, matchingFiles);
            
            // 尝试更宽松的匹配：查找包含文件ID的文件
            const looseMatches = allFiles.filter(f => f.includes(file) || file.includes(f.replace(/[-].*$/, '').replace(/\.\w+$/, '')));
            if (looseMatches.length > 0 && looseMatches.length < 10) {
              console.log(`[RERANK]   宽松匹配的文件:`, looseMatches);
            }
            
            // 列出所有包含 extracted 的文件
            const allExtracted = allFiles.filter(f => f.includes('-extracted.json'));
            if (allExtracted.length > 0 && allExtracted.length < 10) {
              console.log(`[RERANK]   所有已提取的文件:`, allExtracted.map(f => f.replace('-extracted.json', '')));
            }
          } else {
            console.log(`[RERANK]   警告: uploads 目录不存在: ${uploadDir}`);
          }
        }

        // 检查文件是否存在（只处理文档类型，图片等类型没有这些文件）
        if (!fs.existsSync(contentPath) || !fs.existsSync(embeddingsPath)) {
          // 非文档文件（如图片）跳过处理
          console.log(`[RERANK]   跳过文件 ${file}: 缺少提取文件或向量文件`);
          return null;
        }

        try {
          console.log(`[RERANK]   读取内容文件...`);
          const content = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
          console.log(`[RERANK]   内容文件读取成功，标题: ${content.title}`);
          console.log(`[RERANK]   内容块数量: ${content.contents?.length || 0}`);

          console.log(`[RERANK]   读取向量文件...`);
          const embeddings = JSON.parse(fs.readFileSync(embeddingsPath, 'utf8'));
          console.log(`[RERANK]   向量文件读取成功`);
          console.log(`[RERANK]   向量数量: ${embeddings.embeddings?.length || 0}`);

          if (!content.contents || content.contents.length === 0) {
            console.warn(`[RERANK]   警告: 文件 ${file} 的内容为空`);
            return null;
          }

          if (!embeddings.embeddings || embeddings.embeddings.length === 0) {
            console.warn(`[RERANK]   警告: 文件 ${file} 的向量为空`);
            return null;
          }

          if (content.contents.length !== embeddings.embeddings.length) {
            console.warn(`[RERANK]   警告: 文件 ${file} 的内容块数量 (${content.contents.length}) 与向量数量 (${embeddings.embeddings.length}) 不匹配`);
          }

          const fileSimilaritySearchObject = content.contents.map(
            (c: string, i: number) => {
              return {
                fileName: content.title,
                content: c,
                embeddings: embeddings.embeddings[i],
              };
            },
          );

          console.log(`[RERANK]   文件 ${file} 处理成功，返回 ${fileSimilaritySearchObject.length} 个对象`);
          return fileSimilaritySearchObject;
        } catch (error) {
          // 如果读取失败，跳过这个文件
          console.error(`[RERANK]   文件 ${file} 处理失败:`, error);
          if (error instanceof Error) {
            console.error(`[RERANK]   错误堆栈:`, error.stack);
          }
          return null;
        }
      })
      .filter((item) => item !== null) // 过滤掉 null 值
      .flat();

    console.log(`[RERANK] 文件数据处理完成，有效的文件数据对象数量: ${filesData.length}`);

    if (query.toLocaleLowerCase() === 'summarize') {
      console.log('[RERANK] 查询类型: summarize，返回前15个文档');
      return docs.slice(0, 15);
    }

    const docsWithContent = docs.filter(
      (doc) => doc.pageContent && doc.pageContent.length > 0,
    );
    console.log(`[RERANK] 过滤后的有效文档数量: ${docsWithContent.length} (原始: ${docs.length})`);

    if (optimizationMode === 'speed' || this.config.rerank === false) {
      console.log(`[RERANK] 优化模式: ${optimizationMode}, rerank: ${this.config.rerank}`);
      if (filesData.length > 0) {
        console.log(`[RERANK] 处理 ${filesData.length} 个文件数据对象`);
        console.log(`[RERANK] 生成查询向量...`);
        const [queryEmbedding] = await Promise.all([
          embeddings.embedQuery(query),
        ]);
        console.log(`[RERANK] 查询向量生成完成`);

        const fileDocs = filesData.map((fileData) => {
          return new Document({
            pageContent: fileData.content,
            metadata: {
              title: fileData.fileName,
              url: `File`,
            },
          });
        });

        console.log(`[RERANK] 计算相似度，阈值: ${this.config.rerankThreshold ?? 0.3}`);
        const similarity = filesData.map((fileData, i) => {
          const sim = computeSimilarity(queryEmbedding, fileData.embeddings);
          return {
            index: i,
            similarity: sim,
          };
        });

        console.log(`[RERANK] 相似度计算结果数量: ${similarity.length}`);
        if (similarity.length > 0) {
          const maxSim = Math.max(...similarity.map(s => s.similarity));
          const minSim = Math.min(...similarity.map(s => s.similarity));
          console.log(`[RERANK] 相似度范围: ${minSim.toFixed(4)} - ${maxSim.toFixed(4)}`);
        }

        const threshold = this.config.rerankThreshold ?? 0.3;
        let sortedDocs = similarity
          .filter(
            (sim) => sim.similarity > threshold,
          )
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, 15)
          .map((sim) => fileDocs[sim.index]);

        console.log(`[RERANK] 过滤后的文档数量: ${sortedDocs.length} (阈值: ${threshold})`);

        sortedDocs =
          docsWithContent.length > 0 ? sortedDocs.slice(0, 8) : sortedDocs;

        const finalDocs = [
          ...sortedDocs,
          ...docsWithContent.slice(0, 15 - sortedDocs.length),
        ];
        console.log(`[RERANK] 最终返回文档数量: ${finalDocs.length} (文件: ${sortedDocs.length}, 其他: ${finalDocs.length - sortedDocs.length})`);
        return finalDocs;
      } else {
        console.log(`[RERANK] 没有文件数据，仅返回搜索文档`);
        const result = docsWithContent.slice(0, 15);
        console.log(`[RERANK] 返回文档数量: ${result.length}`);
        return result;
      }
    } else if (optimizationMode === 'balanced') {
      console.log(`[RERANK] 优化模式: balanced`);
      console.log(`[RERANK] 生成文档向量和查询向量...`);
      const [docEmbeddings, queryEmbedding] = await Promise.all([
        embeddings.embedDocuments(
          docsWithContent.map((doc) => doc.pageContent),
        ),
        embeddings.embedQuery(query),
      ]);

      console.log(`[RERANK] 向量生成完成，文档向量数: ${docEmbeddings.length}`);

      const fileDocs = filesData.map((fileData) => {
        return new Document({
          pageContent: fileData.content,
          metadata: {
            title: fileData.fileName,
            url: `File`,
          },
        });
      });

      docsWithContent.push(...fileDocs);
      docEmbeddings.push(...filesData.map((fileData) => fileData.embeddings));

      console.log(`[RERANK] 合并后的文档总数: ${docsWithContent.length}`);
      console.log(`[RERANK] 合并后的向量总数: ${docEmbeddings.length}`);

      const threshold = this.config.rerankThreshold ?? 0.3;
      console.log(`[RERANK] 计算相似度，阈值: ${threshold}`);
      const similarity = docEmbeddings.map((docEmbedding, i) => {
        const sim = computeSimilarity(queryEmbedding, docEmbedding);
        return {
          index: i,
          similarity: sim,
        };
      });

      if (similarity.length > 0) {
        const maxSim = Math.max(...similarity.map(s => s.similarity));
        const minSim = Math.min(...similarity.map(s => s.similarity));
        console.log(`[RERANK] 相似度范围: ${minSim.toFixed(4)} - ${maxSim.toFixed(4)}`);
      }

      const sortedDocs = similarity
        .filter((sim) => sim.similarity > threshold)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 15)
        .map((sim) => docsWithContent[sim.index]);

      console.log(`[RERANK] 过滤后的文档数量: ${sortedDocs.length}`);
      return sortedDocs;
    }

    console.log(`[RERANK] 未知的优化模式或处理失败，返回空数组`);
    return [];
  }

  private processDocs(docs: Document[], fileIds: string[] = []) {
    console.log('[PROCESS_DOCS] ===== 开始处理文档内容 =====');
    console.log('[PROCESS_DOCS] 文档数量:', docs.length);
    console.log('[PROCESS_DOCS] 文件ID数量:', fileIds.length);
    console.log('[PROCESS_DOCS] 文件ID列表:', fileIds);

    let processedText = docs
      .map(
        (_, index) =>
          `${index + 1}. ${docs[index].metadata.title} ${docs[index].pageContent}`,
      )
      .join('\n');

    console.log('[PROCESS_DOCS] 处理后的文本长度:', processedText.length);

    // 如果有文件上传但没有文档内容，检查文件类型
    if (fileIds.length > 0 && docs.length === 0) {
      console.log('[PROCESS_DOCS] 警告: 有文件上传但文档内容为空');
      console.log('[PROCESS_DOCS] 文件ID列表:', fileIds);
      const fileInfo = fileIds
        .map((fileId, index) => {
          // 尝试获取文件名和类型
          try {
            const filePath = path.join(process.cwd(), 'uploads');
            const files = fs.readdirSync(filePath);
            const originalFile = files.find(
              (f) =>
                f.startsWith(fileId) &&
                !f.includes('-extracted') &&
                !f.includes('-embeddings'),
            );
            
            // 检查是否是文档文件但处理失败
            const hasExtracted = files.some((f) => f === `${fileId}-extracted.json`);
            const hasEmbeddings = files.some((f) => f === `${fileId}-embeddings.json`);
            
            if (originalFile) {
              const ext = originalFile.split('.').pop()?.toLowerCase();
              const isImage = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext || '');
              const isDocument = ['pdf', 'docx', 'txt'].includes(ext || '');
              
              if (isImage) {
                return `${index + 1}. Image file: ${originalFile} (needs OCR processing)`;
              } else if (isDocument && hasExtracted && hasEmbeddings) {
                // 文档文件已经处理了，但内容没有被加载到context
                return `${index + 1}. Document file: ${originalFile} (content processed but not loaded, please try accessing the file content)`;
              } else if (isDocument) {
                return `${index + 1}. Document file: ${originalFile} (processing may have failed)`;
              } else {
                return `${index + 1}. File: ${originalFile}`;
              }
            }
            return `${index + 1}. Uploaded file: ${fileId}`;
          } catch (error) {
            return `${index + 1}. Uploaded file: ${fileId}`;
          }
        })
        .join('\n');
      
      processedText = `The user has uploaded the following file(s):\n${fileInfo}\n\n`;
      
      // 检查文件类型
      let hasImageFiles = false;
      let hasDocumentFiles = false;
      
      fileIds.forEach((fileId) => {
        try {
          const filePath = path.join(process.cwd(), 'uploads');
          const files = fs.readdirSync(filePath);
          const originalFile = files.find(
            (f) =>
              f.startsWith(fileId) &&
              !f.includes('-extracted') &&
              !f.includes('-embeddings'),
          );
          if (originalFile) {
            const ext = originalFile.split('.').pop()?.toLowerCase();
            if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext || '')) {
              hasImageFiles = true;
            }
            if (['pdf', 'docx', 'txt'].includes(ext || '')) {
              hasDocumentFiles = true;
            }
          }
        } catch {
          // Ignore errors
        }
      });
      
      if (hasImageFiles && hasDocumentFiles) {
        processedText += `Important: You have received both document files (PDF/DOCX/TXT) and image files. Document files (PDF/DOCX/TXT) do NOT need OCR - they contain structured text that is directly accessible. Only image files need OCR processing to extract text. However, it seems the document content is not currently loaded in the context. Please acknowledge the files and inform the user about this situation.`;
      } else if (hasImageFiles) {
        processedText += `Please acknowledge that you have received the file upload(s). For image files, OCR (Optical Character Recognition) processing is needed to extract text content before analysis. Inform the user about this requirement.`;
      } else if (hasDocumentFiles) {
        processedText += `Important: You have received document file(s) (PDF/DOCX/TXT). Document files do NOT need OCR - they contain structured text that should be directly accessible. The files appear to have been processed, but the content is not currently loaded in the context. Please acknowledge that you are aware of the uploaded documents and inform the user that the document content should be available.`;
      } else {
        processedText += `Please acknowledge that you have received the file upload(s). The files have been uploaded but their content is not yet available in the context.`;
      }
      
      console.log('[PROCESS_DOCS] 生成的提示文本长度:', processedText.length);
    }

    console.log('[PROCESS_DOCS] ===== 文档内容处理完成 =====');
    console.log('[PROCESS_DOCS] 最终文本长度:', processedText.length);
    return processedText;
  }

  private async handleStream(
    stream: AsyncGenerator<StreamEvent, any, any>,
    emitter: eventEmitter,
  ) {
    console.log('[LLM] ===== 开始处理流式响应 =====');
    let chunkCount = 0;
    let firstChunkTime: number | null = null;
    const streamStartTime = Date.now();
    
    for await (const event of stream) {
      if (
        event.event === 'on_chain_end' &&
        event.name === 'FinalSourceRetriever'
      ) {
        console.log('[LLM] 上下文检索完成，发送来源信息');
        emitter.emit(
          'data',
          JSON.stringify({ type: 'sources', data: event.data.output }),
        );
      }
      if (
        event.event === 'on_chain_stream' &&
        event.name === 'FinalResponseGenerator'
      ) {
        if (firstChunkTime === null) {
          firstChunkTime = Date.now();
          console.log(`[LLM] 收到第一个响应块（耗时: ${firstChunkTime - streamStartTime}ms）`);
        }
        chunkCount++;
        if (chunkCount % 10 === 0) {
          console.log(`[LLM] 已处理 ${chunkCount} 个响应块`);
        }
        emitter.emit(
          'data',
          JSON.stringify({ type: 'response', data: event.data.chunk }),
        );
      }
      if (
        event.event === 'on_chain_end' &&
        event.name === 'FinalResponseGenerator'
      ) {
        const streamDuration = Date.now() - streamStartTime;
        const timeToFirstChunk = firstChunkTime ? firstChunkTime - streamStartTime : 0;
        console.log(`[LLM] 流式响应完成（总耗时: ${streamDuration}ms，首块时间: ${timeToFirstChunk}ms，总块数: ${chunkCount}）`);
        console.log('[LLM] ===== 流式响应处理完成 =====');
        emitter.emit('end');
      }
    }
  }

  async searchAndAnswer(
    message: string,
    history: BaseMessage[],
    llm: BaseChatModel,
    embeddings: Embeddings,
    optimizationMode: 'speed' | 'balanced' | 'quality',
    fileIds: string[],
    systemInstructions: string,
  ) {
    console.log('[LLM] ===== 开始 LLM 搜索和回答流程 =====');
    console.log('[LLM] 查询内容:', message.substring(0, 100) + '...');
    console.log('[LLM] 历史消息数量:', history.length);
    console.log('[LLM] 优化模式:', optimizationMode);
    console.log('[LLM] 文件ID数量:', fileIds.length);
    const startTime = Date.now();

    const emitter = new eventEmitter();

    console.log('[LLM] 创建回答链...');
    const chainStartTime = Date.now();
    const answeringChain = await this.createAnsweringChain(
      llm,
      fileIds,
      embeddings,
      optimizationMode,
      systemInstructions,
    );
    console.log(`[LLM] 回答链创建完成（耗时: ${Date.now() - chainStartTime}ms）`);

    console.log('[LLM] 开始流式调用 LLM...');
    const invokeStartTime = Date.now();
    const stream = answeringChain.streamEvents(
      {
        chat_history: history,
        query: message,
      },
      {
        version: 'v1',
      },
    );
    console.log(`[LLM] LLM 流式调用已启动（耗时: ${Date.now() - invokeStartTime}ms）`);

    this.handleStream(stream, emitter);

    console.log(`[LLM] ===== LLM 搜索和回答流程完成（总耗时: ${Date.now() - startTime}ms）=====`);
    return emitter;
  }
}

export default MetaSearchAgent;
