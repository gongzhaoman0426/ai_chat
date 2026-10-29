// Minimal anonymized shapes observed in the logged-in Feige page, 2026-09-08.
// Empty legacy fields and rounded numeric SKU IDs are intentional regressions.
export const douyinGoods = {
  code: 0,
  st: 0,
  total: 1,
  page: 0,
  size: 10,
  check_spam_resp: { decision: 'PASS' },
  data: [
    {
      product_id: '',
      product_name: '',
      img: '',
      sku_min_price_str: '',
      sku_max_price_str: '',
      product_item: {
        product_id: '3737994268627829217',
        product_base_info: {
          product_id: 3737994268627829000,
          title: '测试休闲椅',
          main_img: 'https://p9-aio.ecombdimg.com/example.jpg',
          skus: [{ product_id: 3737994268627829000 }],
        },
        marketing_info: {
          marketing_price_prefix: '惠后价',
          price: { effective_min_price: 10000 },
          show_product_marketing_info: {
            show_sku_info: {
              show_price: {
                show_price: {
                  amount: 10000,
                  show_amount: '100.00',
                  price_prefix: '¥',
                  price_suffix: '',
                },
              },
            },
          },
        },
      },
    },
  ],
};
export const douyinDetail = {
  code: 0,
  st: 0,
  data: {
    product_id: '3737994268627829217',
    name: '测试休闲椅',
    img: 'https://p9-aio.ecombdimg.com/example.jpg',
    sku_min_price: 10000,
    sku_max_price: 10000,
    sku_min_price_str: '10000',
    sku_max_price_str: '10000',
  },
};
export const douyinHistory = {
  code: 0,
  st: 0,
  data: {
    msgList: [
      {
        serverMessageId: '7650740519126992135',
        indexInConversation: '1788878584337124',
        messageBody: {
          msgType: 1000,
          content: '商品有哪些颜色',
          createTime: '1788878584337',
          sender: 'test-buyer',
          ext: { type: 'text' },
        },
      },
    ],
    nextCursor: '1788878584337124',
    isFusionUser: true,
    isImChainUser: true,
  },
};
export const douyinEmptyOrders = {
  code: 0,
  st: 0,
  total: 0,
  page: 0,
  size: 10,
  data: [],
  componentized_data: [],
};

// Anonymized material-center response observed on 2026-09-11.
// Root 203 is Feige's built-in "all videos" folder. Empty URLs are intentional:
// this account returns a video ID and signed cover, but no playable video URL.
export const douyinVideoMaterials = {
  code: 0,
  st: 0,
  msg: '',
  check_spam_resp: { decision: 'PASS' },
  data: {
    permission: { has_permission: true },
    materials: {
      total: 1,
      folder_list: [],
      material_list: [
        {
          material_id: '7650740519126992135',
          folder_id: '203',
          origin_url: '',
          small_img_url: '',
          name: '安装演示视频',
          material_type: 'video',
          audit_status: 3,
          audit_status_desc: '审核通过',
          photo_info: null,
          video_info: {
            vid: 'fixture-video-id',
            height: 1080,
            width: 1440,
            format: 'mp4',
            size: 16582779,
            uri: '',
            duration: 7.848,
            video_cover_url:
              'http://p3-shop-material-center-sign.byteimg.com/fixture.jpeg?signature=fixture',
          },
        },
      ],
    },
  },
};
