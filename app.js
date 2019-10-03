var express = require('express');
var https = require('https');
var fs = require('fs');
var app = express();

var options = {
	key: fs.readFileSync('/etc/apache2/ssl_wj/webinarjeo.com.key'),
	cert: fs.readFileSync('/etc/apache2/ssl_wj/__webinarjeo_com/__webinarjeo_com.crt'),
	ca: [fs.readFileSync('/etc/apache2/ssl_wj/__webinarjeo_com/__webinarjeo_com.ca-bundle')],
};

var port = 3005;

var server = https.createServer(options, app);
var io = require('socket.io')(server);

var webinarSocketParams = {};

//webinar napespace in key
var clients = {};
//Rooms with object socketId to user Id example {"room1":{'socketId1':'userId1', 'socketId2':'userId2'}}
var socketIds = {};

app.get('/', function(req, res){
	res.sendFile(__dirname + '/views/index.html');
});

var onConnection = function(socket){
	var user = extractUserFromSocket(socket);
	socket.join(user.webinar_namespace);
	io.to(user.webinar_namespace).emit('peerJoined', user);
	addClient(socket);
	console.log(new Date(), 'Socket Id: '+socket.id, 'User id:'+user.id+', webinar_namespace: '+user.webinar_namespace+' connected', socket.request.headers['user-agent']);
};
var onDisconnection = function(socket){	
	var user = extractUserFromSocket(socket);
	var userId = parseInt(user.id);
	if(typeof webinarSocketParams[user.webinar_namespace] != "undefined"){
		var additionalStreamers = webinarSocketParams[user.webinar_namespace]['additional_streamers'];
		
		if(user.role == 'participant'){
			var ind = additionalStreamers.indexOf(userId);
			if(ind != -1){
				additionalStreamers.splice(ind,1);
				setWebinarSocketParams(user.webinar_namespace, {additional_streamers:additionalStreamers});
			}
		}else if(user.role == 'creator'){
			setWebinarSocketParams(user.webinar_namespace, {additional_streamers:[]});
		}
	}
	
	io.to(user.webinar_namespace).emit('peerLeft', user);
	socket.leave(user.webinar_namespace);
	deleteClient(socket);	
	console.log(new Date(), 'Socket Id: '+socket.id, 'User id:'+user.id+', webinar_namespace: '+user.webinar_namespace+' disconnected', socket.request.headers['user-agent']);	
};

var onSendMessage = function(data, socket){	
	var user = extractUserFromSocket(socket);
	io.to(user.webinar_namespace).emit('incomingMessage', {message:data, userdata:user});
};

var onGetPeers = function(data, socket){
	var namespace = data.webinar_namespace;
	socket.emit('send_peers', {peers: getClientsByNamespace(namespace)});
};

var onNewSelfEvent = function (data, socket) {
    var user = extractUserFromSocket(socket);
    var peers = socketIds[user.webinar_namespace];
    // console.log('onNewSelfEvent');
    // console.log(io.sockets.adapter.rooms[user.webinar_namespace], peers);
    for (var socketId in peers) {
        if (peers[socketId] == user.id) {
            socket.broadcast.to(socketId).emit('new_self_event', data);
        }
    }
};

io.on('connection', function(socket){
	onConnection(socket);
	socket.on('send_message', function(data) { onSendMessage(data, socket); });
	socket.on('get_peers', function(data){ onGetPeers(data, socket) });
    socket.on('new_self_event', function(data){ onNewSelfEvent(data, socket) });
	
	var user = extractUserFromSocket(socket);
	socket.on('setWebinarSocketParams', function(data){
		setWebinarSocketParams(user.webinar_namespace, data);
	});
	
	if(typeof webinarSocketParams[user.webinar_namespace] != "undefined")
		io.to(user.webinar_namespace).emit('webinarSocketParamsUpdated', webinarSocketParams[user.webinar_namespace]);
	
	socket.on('disconnect', function(){
		onDisconnection(socket);
	});	
});

server.listen(port, function(){
	console.log(new Date(), 'Listening port ' + port);
});

function setWebinarSocketParams(namespace, params, emit){
	if(typeof emit == "undefined")
		emit = true;
	
	var needEmit = false;
	
	if(typeof webinarSocketParams[namespace] == "undefined"){
		webinarSocketParams[namespace] = {
			presenter_id: false,
			chat_admins: [],
			additional_streamers: []
		};
	}
	
	var lastUpdatedParams = [];
	for(var i in params){
		if(typeof params[i] == "object" || typeof webinarSocketParams[namespace][i] == "undefined"){
			needEmit = true;
			lastUpdatedParams.push(i);
		}else if(params[i] != webinarSocketParams[namespace][i]){
			needEmit = true;
			lastUpdatedParams.push(i);
		}
		
		webinarSocketParams[namespace][i] = params[i];
		
		if(needEmit && emit){
			switch(i){
				case "chat_admins":
					var admins = webinarSocketParams[namespace][i];
					var clients = getClientsByNamespace(namespace);
					
					for(var j in clients){
						if(admins.indexOf(parseInt(clients[j]['id'])) != -1){
							clients[j]['is_chat_admin'] = 1;
						}else{
							clients[j]['is_chat_admin'] = 0;
						}
					}
				break;
				
				case "additional_streamers":
					var additionalStreamers = webinarSocketParams[namespace][i];
					var clients = getClientsByNamespace(namespace);
					
					for(var j in clients){
						if(additionalStreamers.indexOf(parseInt(clients[j]['id'])) != -1){
							clients[j]['additional_streamers'] = 1;
						}else{
							clients[j]['additional_streamers'] = 0;
						}
					}
				break;
			}
		}
	}
	
	var res = webinarSocketParams[namespace];
	res.lastUpdatedParams = lastUpdatedParams;
	
	if(needEmit && emit){
		io.to(namespace).emit('webinarSocketParamsUpdated', res);
	}
}

function getWebinarSocketParams(namespace, param){
	var res = false;
	if(typeof webinarSocketParams[namespace] == "undefined"){
		return res;
	}
	if(typeof webinarSocketParams[namespace][param] == "undefined"){
		return res;
	}
	
	res = webinarSocketParams[namespace][param];
	
	return res;
}

function getClientsByNamespace(namespace){
	var output_clients = [];
	if(typeof clients[namespace] != "undefined"){
		output_clients = clients[namespace];
	}
	return output_clients;
}

function addClient(socket){
	var user = socket.handshake.query;
	var webinarNamespace = user.webinar_namespace;
	
	user.peerId = clearId(socket.id);
	
	if(typeof socketIds[webinarNamespace] == "undefined"){
		socketIds[webinarNamespace] = {};
	}
	socketIds[webinarNamespace][socket.id] = user.id;
	
	var found = findByUserId(user.id, webinarNamespace);
	
	//presenter connected
	if(typeof user.is_presenter != "undefined" && user.is_presenter == 1){
		setWebinarSocketParams(user.webinar_namespace, {presenter_id: user.id}, false);
	}
	if(found === false){
		if(typeof clients[webinarNamespace] == "undefined"){
			clients[webinarNamespace] = [];
		}
		clients[webinarNamespace].push(user);
	}
}
    
function findByUserId(id, webinarNamespace){
	var flag = false;
	if(typeof webinarNamespace != "undefined" && typeof clients[webinarNamespace] != "undefined"){
		var user = null;
		var webinarUsers = clients[webinarNamespace];
		for(var i=0; i<webinarUsers.length; i++){
			if(webinarUsers[i] !== undefined && webinarUsers[i].id == id){
				flag = true;
				user = webinarUsers[i];
				user.ind = i;
				return user;
			}	
		}
	}
	
	return flag;
}

function deleteClient(socket){
	var user = socket.handshake.query;
	var webinarNamespace = user.webinar_namespace;
	user.peerId = clearId(socket.id);	
	if(socketIds[webinarNamespace][socket.id]){
		delete socketIds[webinarNamespace][socket.id];
	}
	
	var foundUser = findByUserId(user.id, webinarNamespace);
	
	if(foundUser !== false){
		var presenterId = getWebinarSocketParams(user.webinar_namespace, "presenter_id");
		
		//presenter disconnected
		if(presenterId == user.id){
			setWebinarSocketParams(user.webinar_namespace, {presenter_id: false});
		}
		
		var index = foundUser.ind;
		delete clients[webinarNamespace][index];
		clients[webinarNamespace].splice(index, 1);
		if(clients[webinarNamespace].length == 0)
			delete clients[webinarNamespace];
	}
}

function extractUserFromSocket(socket){
	var user = socket.handshake.query;
	user.peerId = clearId(socket.id);
	return user;
}


function clearId(id){
	var tid = id;
	tid = tid.replace("\/", "");
	tid = tid.replace("#", "");
	return tid;
}