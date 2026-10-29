



//获取登录的店铺信息
await (await fetch("https://im.kwaixiaodian.com/gateway/business/cs/solution/login/user/info/get")).json()

//标记已读
let session = await _imsdk.chatSdk.esImSdk.openSession(0,'4059162160')
_imsdk.chatSdk.esImSdk.markSessionRead(session)

//图片链接转换
_imsdk.chatSdk.esImSdk.file.resourceUrlToHttpUrl('ks://b8omrhyu25dkq4nuknpyotvqyy94a8u9s1kyexxm4ar59msbw2nn.jpeg/1')


_imsdk.chatSdk.esImSdk.sendMessage(_imsdk.chatSdk.esImSdk.getKwaiMsgConstructor(0).create({
    targetId: 4059162160,
    targetType: 0,
    text: "text",
    extra: {
        realFromRole: _imsdk.chatSdk.store.state.loginUserInfo.role
    }
}));


async function downloadFile(url) {
    const blob = await (await fetch(url)).blob();
    return new File([blob],encodeURIComponent(url),{
        type: blob.type
    })
}

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
}

const imageFile = await downloadFile("https://jd.dongjiaju.com/uploads/1.jpg")
let {width, height} = await getImageMetadata(imageFile);
_imsdk.chatSdk.esImSdk.sendMessage(_imsdk.chatSdk.esImSdk.getKwaiMsgConstructor(1).create(
{
    targetId: 4059162160,
    targetType: 0,
    image: imageFile,
    width,
    height,
    extra: {
        realFromRole: _imsdk.chatSdk.store.state.loginUserInfo.role
    }
}))


//登录账号的在线状态
async function subscribeUserStatusUpdate(cb) {
    // 获取初始化后的 SDK 实例
    const { chatSdk } = imsdk;
    const { commonRequest } = chatSdk;
  
    try {
      // 获取初始状态
      const { data: { status: initialStatus } } = await commonRequest.getAssistantStatus();
      cb({ status: initialStatus });
    } catch (error) {
      console.error( error);
      return () => {}; // 返回空取消函数
    }
  
    // 定义状态更新处理器
    const handleUserStatusUpdate = ({ status }) => {
      cb({ status });
    };
  
    // 注册事件监听
    chatSdk.on("system.user.status.update", handleUserStatusUpdate);
  
    return createOnceGuard(() => {
      chatSdk.off("system.user.status.update", handleUserStatusUpdate);
    });
}

const unsubscribe = await subscribeUserStatusUpdate(({ status }) => {
console.log('当前助手状态:', status);
}); 

  // 当需要取消订阅时
setTimeout(() => {
    unsubscribe(); // 安全执行，保证只执行一次
}, 5000);

function createOnceGuard(action) {
    let hasExecuted = false;
    return () => {
      if (hasExecuted) return false;
      
      action();
      hasExecuted = true;
      return true;
    };
  }

//聊天對象的切換
async function subscribeChatTargetUpdate(cb) {
    const { chatSdk } = imsdk;
    const {store: {state: {chatTargetSession}}} = chatSdk;

    try {
        cb(chatTargetSession);
    } catch (error) {
        console.error(error);
        return () => {}; // 返回空取消函数
    }

    const handleChatTargetUpdate = (session) => {
        cb(session);
    };

    chatSdk.on("system.chatTargetUpdate", handleChatTargetUpdate);

    return createOnceGuard(() => {
        chatSdk.off("system.chatTargetUpdate", handleChatTargetUpdate);
    });
}  

const unsubscribe = await subscribeChatTargetUpdate(session => {
    console.log('当前session:', session);
}); 
    
    // 当需要取消订阅时
setTimeout(() => {
    unsubscribe(); // 安全执行，保证只执行一次
}, 5000);




//收消息
async function subscribeMessagesUpdateUpdate(cb) {
    const {chatSdk: {esImSdk}} = imsdk;

    const handleMessagesUpdateUpdate = (type, messages, action) => {
        cb(type, messages, action);
    };

    esImSdk.on("messagesUpdate", handleMessagesUpdateUpdate);

    return createOnceGuard(() => {
        esImSdk.off("messagesUpdate", handleMessagesUpdateUpdate);
    });
}  

const unsubscribe = await subscribeMessagesUpdateUpdate((type, messages, action) => {
    console.log('当前message:', type, messages, action);
}); 
    
    // 当需要取消订阅时
setTimeout(() => {
    unsubscribe(); // 安全执行，保证只执行一次
}, 5000);


async function setTextAreaValue(param) {
    const {chatSdk} = imsdk
      , {store: {state: {chatTargetSession}}} = chatSdk
      , {targetId, targetType, text} = param;
    if (!chatTargetSession) return
    if (chatTargetSession.targetId !== targetId.toString() 
        || chatTargetSession.chatTargetType !== targetType) return
    chatSdk.emit("sendBox.input", "text", {
        text: text
    })
}

async function chatWithTargetById(param) {
    const {targetId, chatTargetType} = param;
    await _imsdk.chatSdk.chatWithTargetById(targetId.toString(), chatTargetType)
}

async function closeContact(param) {
    await _imsdk.chatSdk.closeChatSession(param.targetId.toString())
}

//转接到组
async function transferToGroup(param) {
    const {chatSdk: {store: {state: {loginUserInfo: {belongShopId}}}, commonRequest}} = imsdk
    const {assistantGroupId, buyerId, message} = param;
    await commonRequest.batchTransferSessions({
        sellerId: belongShopId.toString(),
        allocationGroupId: assistantGroupId,
        buyerIds: [buyerId],
        message: message
    })
}

//转接到人
async function transferToUser(param) {
    const {chatSdk: {store: {state: {loginUserInfo: {belongShopId}}}, commonRequest}} = imsdk
      , {targetId, buyerId, message} = param;
    await commonRequest.batchTransferSessions({
        sellerId: belongShopId.toString(),
        allocationUserId: targetId.toString(),
        buyerIds: [buyerId],
        message: message
    })
}

//历史消息
async function getMessages(param) {
    const {chatSdk: {esImSdk}} = imsdk
      , {targetId, targetType} = param;
    return await esImSdk.getMessages(`${targetType}_${targetId}`)
}

//获取在线客服
async function getOnlineCsList() {
    const {chatSdk: {commonRequest}} = imsdk
    const {data: {stat}} = await commonRequest.getOnlineCsList();
    return stat
}

//获取在线客服分组
async function getSessionTransferGroupList() {
    const {chatSdk: {commonRequest}} = imsdk
    const {data: {groups}} = await commonRequest.getSessionTransferGroupList();
    return groups
}

async function searchBuyerId(param) {
    const {orderId} = param
    const res = await (await fetch("https://s.kwaixiaodian.com/rest/app/tts/remittance/query/order", {
        headers: {
            "content-type": "application/json;charset=UTF-8"
        },
        credentials: "include",
        method: "post",
        body: JSON.stringify({
            orderNo: orderId
        })
    })).json();
    if (res.result === 1)
        return res.info.buyerId;
    throw new Error(res.error_msg || "查询买家 ID 失败")
}

//获取客户的头像，昵称信息
async function getUserInfoById(param) {
    const {chatSdk: {sessionModel: {provider}}} = imsdk
    const {targetId} = param;
    let user = provider.getUserInfoById(targetId);
    // if (!user) {
    //     const users = await provider.fetchUsersInfoByIds([targetId]);
    //     users.length > 0 && ([user] = users)
    // }
    return user
}


//获取买家订单
async function GetBuyerOrders(param) {
    const {buyerId, limit,offset,orderStatus,itemTitle,oid,searchCondition, } = param
    const res = await (await fetch("https://s.kwaixiaodian.com/gateway/business/cs/order/list?caver=2", {
        headers: {
            "content-type": "application/json;charset=UTF-8"
        },
        credentials: "include",
        method: "post",
        body: JSON.stringify({
          buyerId,
          itemTitle,
          limit,
          offset,
          oid,
          orderStatus,
          searchCondition,
          grayMap:{aftersaleIssue:"true"}})
    })).json();
    return res;
}
