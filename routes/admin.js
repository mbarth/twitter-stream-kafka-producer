var bodyParser = require('body-parser')
    , cookieParser = require('cookie-parser')
    , csurf = require('csurf')
    , express = require('express')
    , extend = require('xtend')
    , forms = require('forms')
    , debug = require('debug')('app:admin')
    , Twitter = require('node-tweet-stream')
    , collectFormErrors = require('express-stormpath/lib/helpers').collectFormErrors;

var kafka_producer;
var io_socket;
var socket_interval_rate = process.env.SOCKET_REPORT_INTERVAL_RATE;
var socket_reporting_interval = setInterval(reportStatsToSocketIOClients, socket_interval_rate);
var twitter_stream = null;
var message_buffer_size = process.env.MESSAGE_BUFFER_SIZE;
var topicName = process.env.KAFKA_TOPIC_NAME;
var consumed_messages_list = [];
var total_tweets_received_count = 0;
var total_messages_sent_count = 0;
var reporting_interval_start_time = 0;
var total_messages_buffered = 0;
var kafka_acked_count = 0;

function processTweet(data) {
    if (data.text === undefined)
        return;
    total_messages_buffered++;
    total_tweets_received_count++;
    var twitter_data = {
        'handle': data.user.screen_name,
        'text': data.text,
        'device': data.source,
        'filter': Session_Variables.filter ? Session_Variables.filter : '',
        'total_count': total_tweets_received_count,
        'start_time' : reporting_interval_start_time
    };
    var message = JSON.stringify(twitter_data);
    consumed_messages_list.push(message);
    // Send if we've hit our buffering limit. The number of buffered messages balances your tolerance for losing data
    // (if the process/host is killed/dies) against throughput (batching messages into fewer requests makes processing
    // more efficient).
    if (consumed_messages_list.length >= Session_Variables.limit) {
        total_messages_sent_count += consumed_messages_list.length;
        var payload = [
            {topic: topicName, messages: consumed_messages_list}
        ];
        var responseHandler = handleProduceResponse.bind(undefined, consumed_messages_list.length);
        // publish tweets to kafka
        kafka_producer.send(payload, responseHandler);
        // reset messages list
        consumed_messages_list = [];
        total_messages_buffered = 0;
    }
}

// Make stats available to web client
function reportStatsToSocketIOClients() {
    var now = Date.now();
    var connections = getSocketIOClientConnections();
    if (connections.length > 0) {
        var perSecond = Math.round(total_tweets_received_count / ((now - reporting_interval_start_time)/1000));
        var status = Session_Variables.stream_status === 'start' ? 'Running' : 'Stopped';
        var total_time = (Session_Variables.stream_status === 'start' ? msToTime(now - reporting_interval_start_time) : '00:00:00.0');
        for (var i=0; i<connections.length; i++) {
            connections[i].emit('stats', {
                stream_status: status,
                filter: (Session_Variables.filter ? Session_Variables.filter : ''),
                total_tweets_received_count: total_tweets_received_count,
                total_messages_sent_count: total_messages_sent_count,
                message_buffer_size: (Session_Variables.limit ? Session_Variables.limit : 0),
                total_messages_buffered: total_messages_buffered,
                perSecond: (Session_Variables.stream_status === 'start' ? perSecond : 0),
                total_time: total_time,
                kafka_acked_count: kafka_acked_count
            });
        }
    }
}

function msToTime(duration) {
    var milliseconds = parseInt((duration%1000)/100)
        , seconds = parseInt((duration/1000)%60)
        , minutes = parseInt((duration/(1000*60))%60)
        , hours = parseInt((duration/(1000*60*60))%24);
    hours = (hours < 10) ? "0" + hours : hours;
    minutes = (minutes < 10) ? "0" + minutes : minutes;
    seconds = (seconds < 10) ? "0" + seconds : seconds;
    return hours + ":" + minutes + ":" + seconds + "." + milliseconds;
}

function handleProduceResponse(batch_messages_count, err, res) {
    if (err) {
        debug("Error sending data to specified topic: " + err);
    } else {
        kafka_acked_count += batch_messages_count;
    }
}

function getSocketIOClientConnections() {
    var res = []
        , rootNamespace = io_socket.of("/");
    for (var id in rootNamespace.connected) {
        res.push(rootNamespace.connected[id]);
    }
    return res;
}

function startTwitterStream() {
    debug('Starting twitter stream');
    // configure twitter stream
    twitter_stream = new Twitter({
        consumer_key: process.env.TWITTER_CONSUMER_KEY,
        consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
        token: process.env.TWITTER_ACCESS_KEY,
        token_secret: process.env.TWITTER_ACCESS_SECRET
    });
    // set up message handler for incoming tweets
    twitter_stream.on('tweet', processTweet);
    var connections = getSocketIOClientConnections();
    if (connections.length > 0) {
        // broadcast event to any listening clients (e.g. stats page)
        for (var i=0; i<connections.length; i++) {
            connections[i].emit('action', {
                message: 'Stream was started'
            });
        }
    }
    // reset stats counters
    reporting_interval_start_time = Date.now();
    total_tweets_received_count = 0;
    total_messages_sent_count = 0;
    kafka_acked_count = 0;
    total_messages_buffered = 0;
}

function stopTwitterStream() {
    debug('Stopping twitter stream');
    twitter_stream.abort();
    twitter_stream = null;
    var connections = getSocketIOClientConnections();
    if (connections.length > 0) {
        // broadcast event to any listening clients (e.g. stats page)
        for (var i=0; i<connections.length; i++) {
            connections[i].emit('action', {
                message: 'Stream was stopped'
            });
        }
    }
}

// Declare the schema of our form:
var adminForm = forms.create({
    filter: forms.fields.string({ required: true }),
    limit: forms.fields.number({ required: true })
});

// A function that will render our form
function renderForm(req,res,locals){
    req.user.groupsNames = [];
    // checking where user is a part of admins group
    req.user.getGroups(function(err, groups) {
        if (err) return next(err);

        groups.each(function(group, cb) {
            req.user.groupsNames.push(group.name);
            cb();
        }, function(err) {
            if (err) return next(err);
            var isAdmin = req.user.groupsNames.indexOf('admins') > -1;
            if (isAdmin) {
                return res.render('admin', extend({
                    // Pass in the membership information to Pug.
                    isAdmin: isAdmin,
                    filter: Session_Variables.filter,
                    stream_status: Session_Variables.stream_status,
                    limit: Session_Variables.limit
                },locals||{}));
            } else {
                res.status(401);
                return res.render('home', {
                    // Pass in the membership information to Pug.
                    isAdmin: false,
                    errors: [{
                        error: 'Authorization Required'
                    }]
                });
            }
        });
    });
}

// Export a function which will create the
// router and return it
module.exports = function admin(io, producer){
    kafka_producer = producer;
    io_socket = io;
    io_socket.sockets.on('connection', function(socket){
        debug('New client socket connection, total:',  getSocketIOClientConnections().length)
    });

    var router = express.Router();

    router.use(cookieParser());

    router.use(bodyParser.urlencoded({ extended: true }));

    // Capture all requests, the form library will negotiate
    // between GET and POST requests

    router.get('/', function(req, res) {
        // set the default value of buffering limit size
        if (!Session_Variables.limit) Session_Variables.limit = message_buffer_size;
        req.user.groupsNames = [];
        // check whether user is a part of admins group
        req.user.getGroups(function(err, groups) {
            if (err) return next(err);

            groups.each(function(group, cb) {
                req.user.groupsNames.push(group.name);
                cb();
            }, function(err) {
                if (err) return next(err);
                var isAdmin = req.user.groupsNames.indexOf('admins') > -1;
                if (isAdmin) {
                    return res.render('admin', {
                        // Pass in the membership information to Pug.
                        isAdmin: isAdmin,
                        filter: Session_Variables.filter,
                        stream_status: Session_Variables.stream_status,
                        limit: Session_Variables.limit
                    });
                } else {
                    // redirecting them to homepage
                    res.status(401);
                    return res.render('home', {
                        // Pass in the membership information to Pug.
                        isAdmin: isAdmin,
                        errors: [{
                            error: 'Authorization Required'
                        }]
                    });
                }
            });
        });
    });

    router.all('/start-stream', function(req, res) {
        if (!twitter_stream &&
            Session_Variables.filter &&
            Session_Variables.filter != '') {
            startTwitterStream();
            Session_Variables.stream_status = 'start';
            debug('Tracking filter: ' + Session_Variables.filter);
            twitter_stream.track(Session_Variables.filter);
            renderForm(req,res,{
                stream_status: Session_Variables.stream_status,
                alert_message: 'The twitter stream has been started'
            });
        } else {
            if (!Session_Variables.filter ||
                Session_Variables.filter === '') {
                renderForm(req,res,{
                    errors: [{
                        error: 'Please enter a filter term'
                    }]
                });
            } else {
                renderForm(req,res,{
                    stream_status: Session_Variables.stream_status,
                    alert_message: 'The twitter stream is currently running'
                });
            }
        }
    });
    router.all('/stop-stream', function(req, res) {
        Session_Variables.stream_status = 'stop';
        if (twitter_stream) {
            stopTwitterStream();
        }
        renderForm(req,res,{
            stream_status: Session_Variables.stream_status,
            alert_message: 'The twitter stream has been stopped'
        });
    });
    router.all('/update-filter', function(req, res) {
        adminForm.handle(req,{
            success: function(form){
                // The form library calls this success method if the
                // form is being POSTED and does not have errors
                if (form.data.filter != '') {
                    if (twitter_stream && Session_Variables.filter != '') {
                        stopTwitterStream();
                        startTwitterStream();
                    }
                    if (twitter_stream) {
                        debug('New filter: ' + form.data.filter.toLowerCase());
                        twitter_stream.track(form.data.filter.toLowerCase());
                    }
                }
                Session_Variables.limit = form.data.limit;
                Session_Variables.filter = form.data.filter.toLowerCase();
                renderForm(req,res,{
                    alert_message: 'Your twitter filter [' + form.data.filter.toLowerCase() + '] has been applied'
                });
            },
            error: function(form){
                // The form library calls this method if the form
                // has validation errors.  We will collect the errors
                // and render the form again, showing the errors
                // to the user
                renderForm(req,res,{
                    errors: collectFormErrors(form)
                });
            },
            empty: function(){
                // The form library calls this method if the
                // method is GET - thus we just need to render
                // the form
                renderForm(req,res,{
                    filter: Session_Variables.filter
                });
            }
        });
    });

    // This is an error handler for this router
    router.use(function (err, req, res, next) {
        // Let the parent app handle the error
        return next(err);
    });

    return router;
};