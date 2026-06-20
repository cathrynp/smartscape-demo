exports.handler = async function(event) {
  if(event.httpMethod==='OPTIONS'){
    return{statusCode:200,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST,OPTIONS'},body:''};
  }
  if(event.httpMethod!=='POST'){
    return{statusCode:405,headers:{'Access-Control-Allow-Origin':'*'},body:'Method not allowed'};
  }

  try{
    const incoming=JSON.parse(event.body);
    const API_KEY=process.env.ANTHROPIC_API_KEY;
    if(!API_KEY){
      return{statusCode:500,headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({error:{message:'API key not configured'}})};
    }

    const requestBody={
      model:'claude-haiku-4-5-20251001',
      max_tokens:800,
      messages:incoming.messages
    };

    const response=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'x-api-key':API_KEY,
        'anthropic-version':'2023-06-01'
      },
      body:JSON.stringify(requestBody)
    });

    const text=await response.text();
    console.log('Anthropic status:',response.status,'response:',text.substring(0,300));

    return{
      statusCode:200,
      headers:{'Access-Control-Allow-Origin':'*','Content-Type':'application/json'},
      body:text
    };

  }catch(err){
    console.log('Error:',err.message);
    return{
      statusCode:500,
      headers:{'Access-Control-Allow-Origin':'*'},
      body:JSON.stringify({error:{message:err.message}})
    };
  }
};
