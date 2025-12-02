import { ConfigModelProvider } from '../config/types';
import BaseModelProvider, {
  createProviderInstance,
} from './providers/baseProvider';
import { getConfiguredModelProviders } from '../config/serverRegistry';
import { providers } from './providers';
import { MinimalProvider, ModelList } from './types';
import configManager from '../config';

class ModelRegistry {
  activeProviders: (ConfigModelProvider & {
    provider: BaseModelProvider<any>;
  })[] = [];

  constructor() {
    this.initializeActiveProviders();
  }

  private initializeActiveProviders() {
    const configuredProviders = getConfiguredModelProviders();

    configuredProviders.forEach((p) => {
      try {
        const provider = providers[p.type];
        if (!provider) throw new Error('Invalid provider type');

        this.activeProviders.push({
          ...p,
          provider: createProviderInstance(provider, p.id, p.name, p.config),
        });
      } catch (err) {
        console.error(
          `Failed to initialize provider. Type: ${p.type}, ID: ${p.id}, Config: ${JSON.stringify(p.config)}, Error: ${err}`,
        );
      }
    });
  }

  async getActiveProviders() {
    const providers: MinimalProvider[] = [];

    await Promise.all(
      this.activeProviders.map(async (p) => {
        let m: ModelList = { chat: [], embedding: [] };

        try {
          m = await p.provider.getModelList();
        } catch (err: any) {
          console.error(
            `Failed to get model list. Type: ${p.type}, ID: ${p.id}, Error: ${err.message}`,
          );

          m = {
            chat: [
              {
                key: 'error',
                name: err.message,
              },
            ],
            embedding: [],
          };
        }

        providers.push({
          id: p.id,
          name: p.name,
          chatModels: m.chat,
          embeddingModels: m.embedding,
        });
      }),
    );

    return providers;
  }

  async loadChatModel(providerId: string, modelName: string) {
    console.log('[MODEL] ===== 开始加载聊天模型 =====');
    console.log('[MODEL] Provider ID:', providerId);
    console.log('[MODEL] Model Name:', modelName);
    const startTime = Date.now();
    
    const provider = this.activeProviders.find((p) => p.id === providerId);

    if (!provider) {
      console.error('[MODEL] 错误: 无效的 Provider ID:', providerId);
      throw new Error('Invalid provider id');
    }

    console.log('[MODEL] Provider 名称:', provider.name);
    console.log('[MODEL] Provider 类型:', provider.type);
    console.log('[MODEL] 调用 provider.loadChatModel...');
    
    try {
      const model = await provider.provider.loadChatModel(modelName);
      const duration = Date.now() - startTime;
      console.log(`[MODEL] 聊天模型加载成功（耗时: ${duration}ms）`);
      console.log('[MODEL] ===== 聊天模型加载完成 =====');
      return model;
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`[MODEL] 聊天模型加载失败（耗时: ${duration}ms）`);
      console.error('[MODEL] 错误详情:', error);
      throw error;
    }
  }

  async loadEmbeddingModel(providerId: string, modelName: string) {
    console.log('[MODEL] ===== 开始加载嵌入模型 =====');
    console.log('[MODEL] Provider ID:', providerId);
    console.log('[MODEL] Model Name:', modelName);
    const startTime = Date.now();
    
    const provider = this.activeProviders.find((p) => p.id === providerId);

    if (!provider) {
      console.error('[MODEL] 错误: 无效的 Provider ID:', providerId);
      throw new Error('Invalid provider id');
    }

    console.log('[MODEL] Provider 名称:', provider.name);
    console.log('[MODEL] Provider 类型:', provider.type);
    console.log('[MODEL] 调用 provider.loadEmbeddingModel...');
    
    try {
      const model = await provider.provider.loadEmbeddingModel(modelName);
      const duration = Date.now() - startTime;
      console.log(`[MODEL] 嵌入模型加载成功（耗时: ${duration}ms）`);
      console.log('[MODEL] ===== 嵌入模型加载完成 =====');
      return model;
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`[MODEL] 嵌入模型加载失败（耗时: ${duration}ms）`);
      console.error('[MODEL] 错误详情:', error);
      throw error;
    }
  }

  async addProvider(
    type: string,
    name: string,
    config: Record<string, any>,
  ): Promise<ConfigModelProvider> {
    const provider = providers[type];
    if (!provider) throw new Error('Invalid provider type');

    const newProvider = configManager.addModelProvider(type, name, config);

    const instance = createProviderInstance(
      provider,
      newProvider.id,
      newProvider.name,
      newProvider.config,
    );

    let m: ModelList = { chat: [], embedding: [] };

    try {
      m = await instance.getModelList();
    } catch (err: any) {
      console.error(
        `Failed to get model list for newly added provider. Type: ${type}, ID: ${newProvider.id}, Error: ${err.message}`,
      );

      m = {
        chat: [
          {
            key: 'error',
            name: err.message,
          },
        ],
        embedding: [],
      };
    }

    this.activeProviders.push({
      ...newProvider,
      provider: instance,
    });

    return {
      ...newProvider,
      chatModels: m.chat || [],
      embeddingModels: m.embedding || [],
    };
  }

  async removeProvider(providerId: string): Promise<void> {
    configManager.removeModelProvider(providerId);
    this.activeProviders = this.activeProviders.filter(
      (p) => p.id !== providerId,
    );

    return;
  }

  async updateProvider(
    providerId: string,
    name: string,
    config: any,
  ): Promise<ConfigModelProvider> {
    const updated = await configManager.updateModelProvider(
      providerId,
      name,
      config,
    );
    const instance = createProviderInstance(
      providers[updated.type],
      providerId,
      name,
      config,
    );

    let m: ModelList = { chat: [], embedding: [] };

    try {
      m = await instance.getModelList();
    } catch (err: any) {
      console.error(
        `Failed to get model list for updated provider. Type: ${updated.type}, ID: ${updated.id}, Error: ${err.message}`,
      );

      m = {
        chat: [
          {
            key: 'error',
            name: err.message,
          },
        ],
        embedding: [],
      };
    }

    this.activeProviders.push({
      ...updated,
      provider: instance,
    });

    return {
      ...updated,
      chatModels: m.chat || [],
      embeddingModels: m.embedding || [],
    };
  }

  /* Using async here because maybe in the future we might want to add some validation?? */
  async addProviderModel(
    providerId: string,
    type: 'embedding' | 'chat',
    model: any,
  ): Promise<any> {
    const addedModel = configManager.addProviderModel(providerId, type, model);
    return addedModel;
  }

  async removeProviderModel(
    providerId: string,
    type: 'embedding' | 'chat',
    modelKey: string,
  ): Promise<void> {
    configManager.removeProviderModel(providerId, type, modelKey);
    return;
  }
}

export default ModelRegistry;
