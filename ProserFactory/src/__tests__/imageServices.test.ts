const mockPost = jest.fn();
const mockGet = jest.fn();
const mockExtend = jest.fn(() => ({ post: mockPost }));

process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:55441/proser_canvas_image_fixture';

jest.mock('dotenv', () => ({__esModule:true, default:{config:jest.fn()}}));

jest.mock('ky', () => ({
  __esModule: true,
  default: {
    extend: mockExtend,
    get: mockGet,
  },
}));

jest.mock('../operations/releaseAdmission', () => ({admitReleaseMutation: jest.fn().mockResolvedValue(undefined)}));

import { ImageService } from '../services/imageService';
import { FluxImageService } from '../services/fluxImageService';

describe('Forge image services', () => {
  beforeEach(() => {
    mockGet.mockReset(); mockGet.mockResolvedValue({text:async()=>JSON.stringify({sd_model_checkpoint:"qwen_image_2.1_int8_convrot.safetensors"})});
    mockPost.mockReset();
    mockExtend.mockClear();
  });

  it('uses the Qwen Image 2.1 defaults for generic image generation', async () => {
    mockPost.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ images: [] }),
    });

    const service = new ImageService('http://127.0.0.1:7861');
    await service.generate({
      prompt: 'cinematic moonlit tower',
      n: 1,
      size: '768x512',
      quality: 'standard',
    });

    expect(mockPost).toHaveBeenCalledWith(
      'http://127.0.0.1:7861/sdapi/v1/txt2img',
      expect.objectContaining({
        json: expect.objectContaining({
          prompt: 'cinematic moonlit tower',
          width: 768,
          height: 512,
          steps: 32,
          cfg_scale: 2.5,
          sampler_name: 'Euler',
          scheduler: 'Simple',
          override_settings: {
            sd_model_checkpoint: 'qwen_image_2.1_int8_convrot.safetensors',
          },
        }),
      }),
    );
  });

  it('uses the Qwen Image 2.1 defaults for Flux generation', async () => {
    mockPost
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ images: [] }),
      });

    const service = new FluxImageService('http://127.0.0.1:7861');
    await service.generate({
      prompt: 'misty archive lit by teal glass',
      width: 512,
      height: 512,
    });

    expect(mockPost).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:7861/sdapi/v1/txt2img',
      expect.objectContaining({
        json: expect.objectContaining({
          prompt: 'misty archive lit by teal glass',
          steps: 32,
          cfg_scale: 2.5,
          sampler_name: 'Euler',
          scheduler: 'Simple',
          override_settings: {
            sd_model_checkpoint: 'qwen_image_2.1_int8_convrot.safetensors',
          },
        }),
      }),
    );
  });
  it('does not repeat an uncertain creation through a different transport', async () => {
    mockPost.mockRejectedValue(new Error('timed out after dispatch'));
    await expect(new ImageService('http://127.0.0.1:7861').generate({prompt:'A lantern'})).rejects.toThrow('timed out');
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('requests native alpha without global checkpoint writes', async () => {
    mockPost.mockResolvedValue({ok:true,json:async()=>({images:[]})});
    await new FluxImageService('http://127.0.0.1:7861').generate({prompt:'A lantern',transparent_background:true});
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith('http://127.0.0.1:7861/sdapi/v1/txt2img',expect.objectContaining({json:expect.objectContaining({prompt:expect.stringContaining('alpha channel')})}));
  });
});
