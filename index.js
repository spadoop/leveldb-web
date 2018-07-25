var http = require('http');
var net = require('net');
var url = require('url');
var fs = require('fs');
var path = require('path');
var moment = require('moment');

var levelup = require('levelup');
var leveldown = require('leveldown');
var mime = require('mime');
var es = require('event-stream');
var WebSocketServer = require('ws').Server;
var WebSocket = require('./websocket');

var staticHandler = function (req, res) {

  if (req.url === '/' || req.url === '/index.html') {
    req.url = '/index.html';
  }

  var rawurl = url.parse(req.url);
  var pathname = decodeURI(rawurl.pathname);
  var base = path.join(__dirname, '..', 'public');
  var filepath = path.normalize(path.join(base, pathname));
  var mimetype = mime.lookup(filepath);

  if (!mimetype) {
    return;
  }

  res.writeHeader(200, {'Content-Type': mimetype});

  fs.stat(filepath, function (err, stat) {

    if (err && err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'plain/text' });
        res.end('not found');
    }
    else {
      if (!stat.isDirectory()) {
        res.writeHead(200, { 'Content-Type': mimetype });
        fs.createReadStream(filepath).pipe(res);
      }
    }
  });
};

module.exports = function(opts) {
  console.log('hithithit',opts);
  opts = opts || {};

  opts.http = opts.http || 80;
  opts.tcp = opts.tcp || 9099;

  var userlocation = path.join(opts.location);
  var favdata = path.join(__dirname, 'cache', 'favs');
  var tagdata = path.join(__dirname, 'cache', 'tags');

  var levelopts = { 
    encoding: opts.encoding || 'json',
    createIfMissing: true
  };
 
  if (opts.keyEncoding) {
    console.log('KEY ENCODING ',opts);
    levelopts.keyEncoding = opts.keyEncoding;
  } 
 
  var db = {};

  levelup(favdata, levelopts, function(error, favdb) {

    db.favdb = favdb;

    levelup(tagdata, levelopts, function(error, tagdb) {

      db.tagdb = tagdb;

      levelopts.createIfMissing = opts.createIfMissing;

      //
      // TODO: handle leveldb errors for the user.
      //
      levelup(leveldown(userlocation), levelopts, function(err, usrdb) {

        if (err) {
          throw new Error(err);
        }

        db.usrdb = usrdb;

        //
        // handle inbound data from tcp
        //
        var tcpserver = net.createServer({ allowHalfOpen: true }, function(socket) {
          socket
            .pipe(es.split())
            .pipe(es.parse())
            .pipe(es.map(function (line, cb) {
              console.debug(line.key+" : "+line.value);
              usrdb.put(line.key, JSON.stringify(line.value));
            }))//usrdb.put('key1', 'value1'))//createWriteStream())
        });

        tcpserver.listen(opts.tcp, function() {
          console.log('tcp server listening on %d', opts.tcp);
        });

        //
        // handle serving the websockets and interface assets
        //
        var httpserver = http.createServer(staticHandler);
        var wss = new WebSocketServer({ 
          server: httpserver.listen(opts.http, function() {
            console.log('http server listening on %d', opts.http);
          }) 
        });

        //
        // handle communication with the server
        //
        wss.on('connection', function(ws) {

          var websocket = new WebSocket(ws);

          function write(object) {
            websocket.write(JSON.stringify(object));
          } 

          function getValue(path, data) {

            var result = data;

            path.forEach(function(segment) {
              result = result[segment.trim()] || false;
            });

            return result;
          }

          function getFormatter(value) {
            switch(value) {
              case 'years':
                return 'YY';
              case 'months':
                return 'YY-MM';
              case 'weeks':
                return 'YY-MM-W';
              case 'days':
                return 'YY-MMM-DD';
              break;
              case 'hours':
                return 'YY-MMM-DD-h-mm';
              break;
              default:
                return 'YY-MMM-DD';
              break;
            }
          }

          function sendKeys(opts, dbname, response) {

            opts = opts || { limit: 1000 };
            var keys = [];

            opts.values = false;

            db[dbname]
              .createReadStream(opts)
              .on('data', function(key) {
                keys.push(key);
              })
              .on('end', function() {

                write({ 
                  response: response,
                  value: keys
                });
              });
          }

          function sendMeta() {
            write({ 
              response: 'metaUpdate',
              value: { path: userlocation }
            });
          }

          function sendValue(key, dbname, request) {

            function get(err, value) {
              if (!err) {

                value = { key: key, value: value };
                write({ response: request, value: value });
              }
            }

            if (dbname === 'favdb') {
              db['usrdb'].get(key, get);
            }
            else {
              db[dbname].get(key, get);
            }
          }

          function deleteValues(operations, opts, dbname, request) {
            db[dbname].batch(operations, function(err) {
              sendKeys(opts, dbname, 'keyListUpdate');
            });
          }

          function updateValue(key, value, dbname) {

            function put(err) {

              //
              // TODO: Handle error properly with user interface feedback.
              //
            }

            if (dbname === 'favdb') {
              db['usrdb'].put(key, value, put);
            }
            else {
              db[dbname].put(key, value, put);
            }
          }

          function validateKey(path, id) {

            var valid = false;

            db['tagdb']
              .createReadStream({ keys: false, limit: 1 })
              .on('data', function(data) {

                valid = !!getValue(path.split('.'), data);

              })
              .on('end', function() {

                var value = { valid: valid, id: id };

                write({ 
                  response: 'validateKey',
                  value: value
                });

              })
          }

          function copyFavKeys(keys) {
            keys.forEach(function(key) {
              db['usrdb'].get(key, function(err, value) {
                if (!err) {
                  db['favdb'].put(key, value);
                }
              });
            });
          }

          function copyTagKeys(keys) {
            keys.forEach(function(key) {
              db['usrdb'].get(key, function(err, value) {
                if (!err) {
                  db['tagdb'].put(key, value);
                }
              });
            });
          }

          function buildTreeMap(token) {

            var metadata = {};

            db['tagdb']
              .createReadStream()
              .on('data', function(data) {

                  var segments = data.key.split(token);
                  var parent = metadata;
                  var size = JSON.stringify(data.value).length;

                  segments.forEach(function(segment, index) {

                    if (segments.length === 1) {
                      var value = { name: data.key, size: size };

                      if (parent[segment]) {
                        parent[segment].push(value);
                      }
                      else {
                        parent[segment] = [value];
                      }
                    }
                    else if (index < segments.length-2) {
                      parent = parent[segment] || (parent[segment] = {});
                    }
                    else if (index === segments.length-2) {
                      parent = parent[segment] || (parent[segment] = []);
                    }
                    else {
                      parent.push({
                        name: data.key,
                        size: size
                      });
                    }
                });

              })
              .on('end', function() {
                
                var tree = {
                  name: "treemap",
                  children: []
                };

                function compile(tree, metadata) {

                  if (Array.isArray(metadata)) {
                    tree.children = metadata;
                  }
                  else {
                    Object.keys(metadata).forEach(function(key) {
                        var next = { name: key, children: [] };
                        tree.children.push(next);
                        compile(next, metadata[key]);
                    });
                  }

                  return tree;
                }

                write({ 
                  response: 'buildTreeMap',
                  value: compile(tree, metadata)
                });
              });
          }

          function buildStackedAreaChart(opts) {

            var pathToX = opts.pathToX.split('.');
            var pathsToValues = [];
            var metadata = {};
            var dateStart;
            var dateEnd;

            if (opts.dateStart && opts.dateStart) {
              dateStart = moment(opts.dateStart).format(opts.dateTimeFormat);
              dateEnd = moment(opts.dateEnd).format(opts.dateTimeFormat);
            }

            opts.pathsToValues.split(',').forEach(function(path) {
              pathsToValues.push(path.split('.'));
            });

            db['tagdb']
              .createReadStream()
              .on('data', function(data) {

                var X = getValue(pathToX, data.value);

                if (X && opts.dateTimeFormat) {
                  X = moment(X).format(opts.dateTimeFormat);
                }

                if (dateStart && dateStart && 
                  (moment(X).isBefore(dateStart) || moment(X).isAfter(dateEnd)) ) {
                  return;
                }

                pathsToValues.forEach(function(path) {

                  var value = getValue(path, data.value);

                  if (X && typeof value !== 'undefined') {

                    var pair = {};
                    pair[path[path.length-1]] = value;

                    if (!metadata[X]) {
                      metadata[X] = pair;
                    }
                    else {
                      metadata[X][path[path.length-1]] = value;
                    }
                  }
                });

              })
              .on('end', function() {

                var value = [];

                Object.keys(metadata).forEach(function(X) {

                  var item = { X: X };

                  Object.keys(metadata[X]).forEach(function(key) {
                    item[key] = metadata[X][key];
                  });

                  value.push(item);
                });

                write({ 
                  response: 'buildStackedAreaChart',
                  value: value
                });

              });
          }

          function buildBarChart(opts) {

            var pathToX = opts.pathToX.split('.');
            var pathToY = opts.pathToY.split('.');

            var metadata = [];
            var dateStart;
            var dateEnd;
            var dateFormatter = opts.dateTimeFormat || "MM-DD-YY";

            if (opts.dateStart && opts.dateEnd) {
              dateStart = moment(opts.dateStart).format(dateFormatter);
              dateEnd = moment(opts.dateEnd).format(dateFormatter);
            }

            db['tagdb']
              .createReadStream()
              .on('data', function(data) {

                var X = getValue(pathToX, data.value);
                var Y = getValue(pathToY, data.value) || data.key;
                var date;

                if (moment(X).isValid()) {
                  date = moment(X).format(dateFormatter);

                  if (dateStart && dateEnd &&
                    (moment(date).isBefore(dateStart) || moment(date).isAfter(dateEnd)) ) {
                    return;
                  }
                }

                metadata.push({ X: X, Y: Y, key: data.key });

              })
              .on('end', function() {

                write({ 
                  response: 'buildBarChart',
                  value: metadata
                });
              });
          }

          websocket.on('data', function(message) {

            try {
              message = JSON.parse(message);
            }
            catch($) {}

            var dbname = message.dbname;
            var request = message.request;
            var value = message.value;
     
            if (request === 'keyListUpdate') {
              sendKeys(value, dbname, 'keyListUpdate');
            }
            else if (request === 'editorUpdate') {
              sendValue(value, dbname, 'editorUpdate');
            }
            else if (request === 'deleteValues') {
              deleteValues(value.operations, value.opts, dbname, 'deleteValues');
            }
            else if (request === 'updateValue') {
              updateValue(value.key, value.value, dbname);
            }
            else if (request === 'validateKey') {
              validateKey(value.key, value.id);
            }
            else if (request === 'favKeys') {
              copyFavKeys(value);
            }
            else if (request === 'tagKeys') {
              copyTagKeys(value);
            }
            else if (request === 'allTaggedKeys') {
              sendKeys(value, dbname, request);
            }
            else if (request === 'buildTreeMap') {
              buildTreeMap(value);
            }
            else if (request === 'buildStackedAreaChart') {
              buildStackedAreaChart(value);
            }
            else if (request === 'buildBarChart') {
              buildBarChart(value);
            }

          });

          sendMeta();
          sendKeys({}, 'usrdb', 'keyListUpdate');
        });
      });
    });
  });
};
