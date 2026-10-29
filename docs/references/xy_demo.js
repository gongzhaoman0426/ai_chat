
//收消息
imsdk.chatSdk.registerMessageChangeLisnter({onAdd: function(eu) {
                       console.log(eu)}
                })

//获取当前登录的用户
await lib.mtop.request({
    api: 'mtop.taobao.idlemessage.pc.loginuser.get',
    v: "1.0",
    data: {}
});

//获取买家信息
await lib.mtop.request({
                        api: 'mtop.taobao.idlemessage.pc.user.query',
                        v: "4.0",
                        data: {"type":0,"sessionType":1,"sessionId":sessionId,"isOwner":false}
                    });


//发文字
_imsdk.getMessageServiceSync().sendMessage({
      sessionId, //"56514156666",
      content: {
        contentType: 1,
        text: {
          text: content
        }
      }
    })

//标记已读
_imsdk.getMessageServiceSync().updateMessageToRead(sessionId,msgs,imsdk._engine.store.convMap.get(sessionId),1)

//订单发货
await lib.mtop.request({
    api: 'mtop.taobao.idle.logistic.consign.dummy',
    v: "1.0",
    data: {"orderId":"4951116036319758915", "tradeText":"哈哈","picList":[],"newUnconsign":true}
})



//咨询商品
await lib.mtop.request({
    api: 'mtop.idle.trade.pc.message.headinfo',
    v: "1.0",
    data: {"itemId":1001042843062,"sessionId":56514156666,"sessionType":1}
})
