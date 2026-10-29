// 飞鸽工作台控制台探路笔记，不是运行时代码。
// 实际桥接：resources/douyin-bridge.js。说明：docs/douyin-integration.md

//接受消息
__workbench__.workbenchOptions.extra.im.message$.subscribe(e => {
    console.log(e)
})


//发文字
__workbench__.workbenchOptions.extra.im.sendText('2664827077531421:30712207::2:1:pigeon', '654654', {
    "p:check_Send":'12718000-f4de-11ef-b990-cdabf6ddc509'})



function getImageMetadata(imageBlob) {
    return new Promise((resolve, reject) => {
      // 创建临时对象 URL

      const objectUrl = URL.createObjectURL(imageBlob);
      
      // 创建图片元素加载资源
      const image = new Image();
  
      // 定义清理资源的函数
      const cleanup = () => URL.revokeObjectURL(objectUrl);
  
      // 图片加载成功处理
      image.onload = () => {
        cleanup();
        resolve({
          width: image.naturalWidth,  // 使用自然宽高而非显示尺寸
          height: image.naturalHeight
        });
      };
  
      // 图片加载失败处理
      image.onerror = () => {
        cleanup();
        reject(new Error("图片元数据获取失败：无法加载图片文件"));
      };
  
      // 开始加载图片
      image.src = objectUrl;
});

function downloadFile(imageUrl) {
    let imageName = imageUrl.split("/").pop()
    let ext = imageName.split(".").pop()
    return new Promise(resolve => {
        fetch(imageUrl).then(r => r.blob()).then(res => {
            const f = new File([res],imageName,{
                type: "image/" + ext
            });
            return resolve(f)
        }
        )
    }
    )
}

function doUploadImage() {
    let chunkName;
    if ("masterWebpackJsonp" in window) {
        chunkName = "masterWebpackJsonp";
    } else {
        chunkName = Object.keys(window).find(key => 
            key.startsWith("@ecom-vmok/pigeon-im-pc")
        );
    }
    if (!chunkName) return null;

    let doUploadImageFunc = null;
    const webpackChunk = window[chunkName];
    
    const processChunk = (modules) => {
        for (const [moduleId, moduleDefinition] of Object.entries(modules.m)) {
            if (moduleDefinition.toString().includes("doImageXUpload")) {
                const moduleExports = modules(moduleId);
                if (moduleExports?.iP && typeof moduleExports.iP === "function") {
                    doUploadImageFunc = moduleExports.iP;
                }
            }
        }
    };

    webpackChunk.push([
        [Symbol("inject")], 
        {},                                    
        processChunk                  
    ]);
    webpackChunk.pop();

    return doUploadImageFunc;
}

fsdk= doUploadImage()

//下载图片
imageFile =  await downloadFile("https://jd.dongjiaju.com/uploads/3.jpg")
//上传图片
let imageUpload = await fsdk(imageFile)

//发图片

__workbench__.workbenchOptions.extra.im._sendMsg('AQA-51BEvda3BR9phRwCAd2l_a71jwmOWwvOoVPe4f4N1rAsm6T2SqzhyX8SJfu1vkTW9xKuyEKA3ieSX5fWB6Ky:30712207::2:1:pigeon', 
{
    content: "[图片]",
    type: "file_image",
    ext: { 
        imageUrl:imageUpload.uri,
        imageWidth: "254",
        imageHeight: "254",
        tag_valid: "1",
        uuid: '12718000-f4fe-11fe-b990-cdabf6dfc920',
        robot_recommend: "1"
    }
})

__workbench__.workbenchOptions.extra.im._sendMsg("2664827077531421:30712207::2:1:pigeon", 
{
    content: "[图片]",
    type: "file_image",
    ext: { 
        imageUrl:imageUpload.uri,
        imageWidth: "254",
        imageHeight: "254",tag_valid: "1",
        uuid: '12718000-f4fe-11fe-b990-cdabf6dfc919'
    }
})

 __workbench__.workbenchOptions.extra.im.sendImageByRobot('AQA-51BEvda3BR9phRwCAd2l_a71jwmOWwvOoVPe4f4N1rAsm6T2SqzhyX8SJfu1vkTW9xKuyEKA3ieSX5fWB6Ky:30712207::2:1:pigeon',
     "你好", {"p:check_Send":crypto.randomUUID()})

 __workbench__.workbenchOptions.extra.im.sendText(uid, content, {"p:check_Send":crypto.randomUUID()})


//获取素材中心的视频
__workbench__.workbenchOptions.extra.get("/backstage/search_pigeon_materials", {
    material_type: "video",
    order_by: 'UpdateTimeDesc',
    page: 1,
    parent_folder_id: 203,
    size: 20
})


//发视频
await __workbench__.workbenchOptions.extra.im.sendVideo("2664827077531421:30712207::2:1:pigeon",{
    "videoId":"v0d27cg10001cv7qjn7og65lc5461qmg",
    "width":1440,
    "height":1080,
    "coverURL":"http://p3-shop-material-center-sign.byteimg.com/tos-cn-v-2e5523/ogeP0e1fDA1jG7sgCGVIJ5CaUBnLQGTSPqOhts~tplv-232p484bck-image.jpeg?lk3s=be0766e8&x-expires=1773199188&x-signature=OxYVQY4lDs8Y9NzV6QbEVIk7OEI%3D",
    "duration":7.848
})

//当前店铺用户信息
await __workbench__.workbenchOptions.extra.get("/backstage/currentuser")


//商品详情
await __workbench__.workbenchOptions.extra.get("/pcbackstage/productdetail",
    {
        product_id: "3737994268627829216",
        user_id: "2664827077531421",
        security_user_id: "AQA-51BEvda3BR9phRwCAd2l_a71jwmOWwvOoVPe4f4N1rAsm6T2SqzhyX8SJfu1vkTW9xKuyEKA3ieSX5fWB6Ky",
        channel_params:'',
        type: '',
        card_uuid: ''
    })

//足迹
await __workbench__.workbenchOptions.extra.get("/pcbackstage/workstation/get_product_list",
    {
        user_id:"2664827077531421",
        security_user_id: "AQA-51BEvda3BR9phRwCAd2l_a71jwmOWwvOoVPe4f4N1rAsm6T2SqzhyX8SJfu1vkTW9xKuyEKA3ieSX5fWB6Ky",
        app_id:1128,
        page_no:0,
        page_size:10,
        presale_biz_scene:"b_user_footprint"
    })


function doUploadVideo() {
    let chunkName;
    if ("masterWebpackJsonp" in window) {
        chunkName = "masterWebpackJsonp";
    } else {
        chunkName = Object.keys(window).find(key => 
            key.startsWith("@ecom-vmok/pigeon-im-pc")
        );
    }
    if (!chunkName) return null;

    let doUploadVideoFunc = null;
    const webpackChunk = window[chunkName];
    
    const processChunk = (modules) => {
        for (const [moduleId, moduleDefinition] of Object.entries(modules.m)) {
            if (moduleDefinition.toString().includes("upload-video-success")) {
                const moduleExports = modules(moduleId);
                //console.log(moduleDefinition.toString());
                if (moduleExports?.og && typeof moduleExports.og === "function") {
                    doUploadVideoFunc = moduleExports.og;
                }
            }
        }
    };

    webpackChunk.push([
        [Symbol("injectv")], 
        {},                                    
        processChunk                  
    ]);
    webpackChunk.pop();

    return doUploadVideoFunc;
}

let vsdk = doUploadVideo()

async function downloadFile(url) {
    const blob = await (await fetch(url)).blob();
    return new File([blob],encodeURIComponent(url),{
        type: blob.type
    })
}
//上传视频
let videoFile = await downloadFile("https://jd.dongjiaju.com/uploads/2.mp4")
// let ddd =await vsdk(videoFile,2664827077531421)
await __workbench__.workbenchOptions.extra.im.sendVideo("2664827077531421:30712207::2:1:pigeon",videoFile,(t=>vsdk(t,2664827077531421)))

//发送商品卡片
await __workbench__.workbenchOptions.extra.im.sendCard(
    {
        card_type: "goods_card",
        content: "[商品]",
        conversation_id: "2664827077531421:30712207::2:1:pigeon",
        data_id: "3737994268627829216",
        extra: undefined,
        message_ext: JSON.stringify({
            "type": "goods_card",
            "card_type": "goods_card",
            "start_scene": "1",
            "tag_valid": "1",
            "goods_id": "3737994268627829216",
            "p:uuid": "bc4bf43a-d308-4e51-87f8-2c48da1953f4"
        }),
        shop_id: undefined,
        user_id: undefined
    })
    

//邀请下单
await __workbench__.workbenchOptions.extra.post("/backstage/workstation/order_create_care",{"product_id":"3737994268627829216","user_id":"2664827077531421"})

//商品列表
await __workbench__.workbenchOptions.extra.get("/backstage/workstation/get_product_list",
    {
        "service_entity_id":"",
        "security_user_id":"AQBENxclacCrrO3Qpx3yh20l_a71jwmOWwvOoVPe4f4N1jSiJF4k93o_NlyOqj01mT_XoU7NMcIxuhUKvE7cTz5W",
        "page_no":0,
        "page_size":10,
        "check_status":3,
        "hot_style":0,"status":0,
        "is_channel":0,"business_type":4,
        "biz_type":4,"search_words":"",
        "presale_biz_scene":"b_product_list"
    }
)

UserModel = __workbench__.workbenchOptions.extra.DI.get(__workbench__.workbenchOptions.extra.UserModelSymbol)

//店鋪的用戶信息
UserModel.state  

PCUIModel = __workbench__.workbenchOptions.extra.DI.get(__workbench__.workbenchOptions.extra.PCUIModelSymbol)


//监听账号状态切换
PCUIModel.state$ && PCUIModel.state$.subscribe(async e => {
    console.log(e)
})

//关闭聊天窗口
await __workbench__.workbenchOptions.extra.im.sendCloseConversationByCustomer('2664827077531421:30712207::2:1:pigeon')

//聊天对象的详细信息
await __workbench__.workbenchOptions.extra.im.getConversation('2664827077531421:30712207::2:1:pigeon')

//创建会话
await __workbench__.workbenchOptions.extra.im.createConversation('2664827077531421')

//标记已读
await __workbench__.workbenchOptions.extra.im.markReadConversation('2664827077531421:30712207::2:1:pigeon',msgobj)
await __workbench__.workbenchOptions.extra.im.markReadMessage('2664827077531421:30712207::2:1:pigeon',msgobj)

//店铺客服列表
await __workbench__.workbenchOptions.extra.get("/pcbackstage/getCanAssignStaffList")
await __workbench__.workbenchOptions.extra.get("/backstage/getCanAssignStaffList")
PCUIModel.state.serviceList.map(e => e.id)
//转接到个人
await __workbench__.workbenchOptions.extra.im.sendTransferService('2664827077531421:30712207::2:1:pigeon', kefu_targetId)

//店铺分组列表
await  __workbench__.workbenchOptions.extra.get("/backstage/queryShopGroupListWithCustomer")
//转接到分组
await __workbench__.workbenchOptions.extra.post("/backstage/conversationToShopGroup", {
    fromStaffId: '',//客服id
    groupId: '',   // 分组id
    receiverUid: '',  // 客户id
    ignoreSnap: false,//false == 不转接到小休客服 
})


//修改订单备注
__workbench__.workbenchOptions.extra.post("/backstage/workshop/addRemark?_pms=1", {
    order_id:"6940681128302286261",
    remark_info:{
        is_add_remark:true,
        is_add_star:true,
        remark:"6549879879789 03-21 18:34】",
        star:4
    },
    order_remark_auto_expand:true
})




//新版
await __workbench__.workbenchOptions.extra.get("/chat/api/backstage/conversation/get_history_msg",{
    biz_type:4,
    PIGEON_BIZ_TYPE:2,
    _pms:1,
    device_platform:"web",
    FUSION:true,
    cursor: 0,
    securityUserId:"AQA-51BEvda3BR9phRwCAd2l_a71jwmOWwvOoVPe4f4N1rAsm6T2SqzhyX8SJfu1vkTW9xKuyEKA3ieSX5fWB6Ky",
    securityBizConversationId:"AQA-51BEvda3BR9phRwCAd2l_a71jwmOWwvOoVPe4f4N1rAsm6T2SqzhyX8SJfu1vkTW9xKuyEKA3ieSX5fWB6Ky:30712207::2:1:pigeon",
    direction: 0,
    size: 30
})
//当前登录的用户信息
await __workbench__.workbenchOptions.extra.get("/backstage/currentuser",{
    _pms: 1,
   biz_type: 4
})

await __workbench__.workbenchOptions.extra.get("/backstage/getRealtimeStaffStatistics",{
    queryStaffName: "",
     shopId: 30712207,
     page: 1,
     size: 20,
     staffStatus: 1
 })

 //买家订单
 await __workbench__.workbenchOptions.extra.post("/backstage/cmpoent/order/query",{
	"security_user_id": "AQBENxclacCrrO3Qpx3yh20l_a71jwmOWwvOoVPe4f4N1jSiJF4k93o_NlyOqj01mT_XoU7NMcIxuhUKvE7cTz5W",
	"page_no": 0,
	"page_size": 5,
	"tab_type": 0,
	"search_words": "",
	"is_init_tab": 0,
	"biz_type": 2,
	//"from_conversation_short_id": "7650740519126992134",
	"version": "1.0",
	"open_params": {},
	"workstation_opt_version": "v2",
	"service_entity_id": "",
	"workstation_opt_gray": true
})

 await __workbench__.workbenchOptions.extra.post("/pcbackstage/workstation/get_product_list",{"page_no":0,"page_size":10,"check_status":3,"hot_style":0,"status":0,"is_channel":0,"business_type":4,"biz_type":4,"search_words":"","user_id":"100443187769","presale_biz_scene":"b_product_list"})



 await __workbench__.workbenchOptions.extra.get("/backstage/getuserinfo",{uids:[]})




await __workbench__.workbenchOptions.extra.get("/backstage/getURLForURI",{     
    uri:'tos-cn-i-scl3phc04j/9e77197cc9fa48088e4a10ddcc3da349',
    file_type:"image"        
})

 search_reply(e, t) {
                const s = e || {}
                  , r = this.genBaseURL("/backstage/quickreply/searchReply")
                  , a = {
                    keyword: s.keyword,
                    type: s.type,
                    page: s.page,
                    size: s.size,
                    related_search_cond: s.related_search_cond,
                    need_close: s.need_close,
                    need_indicator: s.need_indicator,
                    reply_type: s.reply_type
                };



await __workbench__.workbenchOptions.extra.DI.get(__workbench__.workbenchOptions.extra.PCRiskControlAdapterSymbol).PCRiskControlIO.axios.get("https://pigeon.jinritemai.com/backstage/currentuser",{
             _pms: 1,
   biz_type: 4
        })

//邀请评价

__workbench__.workbenchOptions.extra.im.sendCustomCard('AQA21C9uakq52URrYdShsDQiERrjUtz0IDDxrjLfZFa9GoZsLB0gB7cglpWBkmQKp-BXp0o3gEJqf9c8XAs8E-nB:185334892::2:1:pigeon',{
	"card_type": "comment",
	"data_id": "6928494914749956044"
})
__workbench__.workbenchOptions.extra.im.sendCustomCard('AQA21C9uakq52URrYdShsDQiERrjUtz0IDDxrjLfZFa9GoZsLB0gB7cglpWBkmQKp-BXp0o3gEJqf9c8XAs8E-nB:185334892::2:1:pigeon',{
	"card_type": "comment",
	"data_id": "6928494914749956044",
	"shop_id": 185334892,
	"uuid": "",
	"encode_shop_id": "",
	"extra": "{\"product_id\":\"3734309510899171409\"}",
	"src": "https://p26.douyinpic.com/aweme/100x100/aweme-avatar/tos-cn-i-0813c001_o0aD8ATAEGpAQ4FARgIAjnpfUfo7EEBt2IBfwB.jpeg?from=4010531038",
	"user_id": "",
	"coupon_meta_id": "https://p26.douyinpic.com/aweme/100x100/aweme-avatar/tos-cn-i-0813c001_o0aD8ATAEGpAQ4FARgIAjnpfUfo7EEBt2IBfwB.jpeg?from=4010531038",
	"coupon_id": "",
	"ke_fu_coupon_type": "https://p26.douyinpic.com/aweme/100x100/aweme-avatar/tos-cn-i-0813c001_o0aD8ATAEGpAQ4FARgIAjnpfUfo7EEBt2IBfwB.jpeg?from=4010531038",
	"need_open_after_sale_entry": false,
	"card_url_context_params": {url:"https://p26.douyinpic.com/aweme/100x100/aweme-avatar/tos-cn-i-0813c001_o0aD8ATAEGpAQ4FARgIAjnpfUfo7EEBt2IBfwB.jpeg?from=4010531038"},
	"security_user_id": "AQA21C9uakq52URrYdShsDQiERrjUtz0IDDxrjLfZFa9GoZsLB0gB7cglpWBkmQKp-BXp0o3gEJqf9c8XAs8E-nB"
})
