var express = require('express')
    , logger = require('morgan')
    , app = express()
    , debug = require('debug')('app:server')
    , http = require('http').createServer(app)
    , socket_io = require('socket.io')(http)
    , stormpath = require('express-stormpath')
    , kafka = require('kafka-node')
    , Producer = kafka.Producer
    , client = new kafka.Client() // using default values of 'localhost:2181'
    , producer = new Producer(client);

Session_Variables = {};

app.io = socket_io;

app.use(logger('dev'));
app.use(express.static(__dirname + '/static'));

app.set('views', './views');
app.set('view engine', 'pug');

app.use(stormpath.init(app, {
    expand: {
        customData: true
    }
}));

app.use('/profile',stormpath.loginRequired,require('./routes/profile')());
app.use('/admin',stormpath.loginRequired,require('./routes/admin')(socket_io, producer));

app.get('/', stormpath.getUser, function(req, res) {
    if (req.user) {
        // performing check against group set up in stormpath
        // verifying user belongs to admins group
        req.user.groupsNames = [];
        req.user.getGroups(function(err, groups) {
            if (err) return next(err);

            groups.each(function(group, cb) {
                req.user.groupsNames.push(group.name);
                cb();
            }, function(err) {
                if (err) return next(err);
                return res.render('home', {
                    // Pass in the membership information to Pug.
                    isAdmin: req.user.groupsNames.indexOf('admins') > -1
                });
            });
        });
    } else {
        return res.render('home', {
            // Pass in the membership information to Pug.
            isAdmin: false
        });
    }
});

app.get('/stats', stormpath.loginRequired, function(req, res) {
    // performing check against group set up in stormpath
    // verifying user belongs to admins group
    req.user.groupsNames = [];
    req.user.getGroups(function(err, groups) {
        if (err) return next(err);

        groups.each(function(group, cb) {
            req.user.groupsNames.push(group.name);
            cb();
        }, function(err) {
            if (err) return next(err);
            return res.render('stats', {
                // Pass in the membership information to Pug.
                isAdmin: req.user.groupsNames.indexOf('admins') > -1,
                port: process.env.PORT
            });
        });
    });
});

app.use(function(req, res) {
    res.status(404);
    url = req.url;
    res.render('404.pug', {title: '404: File Not Found', url: url });
});

app.on('stormpath.ready',function(){
    debug('Stormpath Ready');
});

producer.on('ready', function () {
    debug('Kafka Producer Ready');    
});

http.listen(process.env.PORT, function() {
    console.log('The server is running at http://localhost:'+ process.env.PORT);
});
