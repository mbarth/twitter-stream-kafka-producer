twitter-stream-kafka-producer
==================

twitter-stream-kafka-producer is a sample app that makes use of [kafka-node](https://www.npmjs.com/package/kafka-node) libraries to
publish [twitter](https://www.npmjs.com/package/node-tweet-stream) streams to a kafka server. It makes use of [express](http://expressjs.com/) for application endpoint management, 
[stormpath](https://stormpath.com/) for user management, [pug](https://github.com/pugjs) as the template engine, [C3](http://c3js.org/) for charts, and [socket.io](http://socket.io/).  


Getting Started
---------------

Install the required libraries via npm:

    npm install
    npm run start-windows [start-linux] // depending on your environment

You will need to have a Kafka server running. The [Kakfa Quickstart](http://kafka.apache.org/quickstart)
documentation explains how to do this step-by-step.