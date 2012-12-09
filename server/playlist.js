var dbConnectionPool	= require('./db').getConnectionPool(),
	mediaRouterBase		= require('./router'),
	$					= require('./jquery.whenall'),
	crypto				= require('crypto'),
	cacher				= require('node-dummy-cache'),
	_					= require('underscore')._;
	
var playlistCache = cacher.create(cacher.ONE_SECOND * 45, cacher.ONE_SECOND * 30);

var setTimeoutReject = function(deferred, time) {
	time = time || 30000; // default timeout is 30 ms
	setTimeout(function() {
		if (deferred.state() == 'pending') {
			deferred.reject("Timeout after " + time + " ms");
		}
		console.log("Timing out promise");
	}, time);
}

var uniqueMedia = function(mediaList) {
	var seen = {};
	return _.chain(mediaList).map(function(media) {
		var stringEquiv = media.siteCode + '=' + media.siteMediaID;
		if (!seen[stringEquiv]) {
			seen[stringEquiv] = true;
			return media;
		} else {
			return false;
		}
	}).filter(function(media) {
		return false !== media;
	}).value();
};

var verifyPlaylist = function(playlist) {
	var result = $.Deferred(), i, pair;
	playlist = uniqueMedia(playlist);
	var playlistLength = playlist.length;
	if (!playlistLength) {
		return result.reject();
	}
	dbConnectionPool.acquire(function(acquireError, connection) {
		if (acquireError) {
			console.log(acquireError);
			result.reject();
			dbConnectionPool.release(connection);
			return;
		}
		var resultName = "count";
		var queryString = ["SELECT COUNT(id) AS " + resultName + " FROM KnownMedia WHERE "];
		for (i in playlist) {
			pair = playlist[i];
			queryString.push("(site=" + connection.escape(pair.siteCode) + " AND mediaid=" + connection.escape(pair.siteMediaID) + ")");
			if (parseInt(i) < playlistLength - 1) {
				queryString.push(" OR ");
			}
			else {
				queryString.push(";");
			}
		}
		connection.query(queryString.join(""), function(queryError, rows) {
			if (queryError) {
				console.log(queryError);
				result.reject();
			}
			else if (rows.length) {
				var row = rows[0];
				var count = row[resultName];
				if (parseInt(count) === playlistLength) {
					result.resolve(true);
				} else {
					console.log('Some media found: ' + count + ' out of ' + playlistLength + 'expected');
					result.reject();
				}
			} else {
				console.log('no results for verification');
				result.reject();
			}
			dbConnectionPool.release(connection);
		});
	});
	
	return result.promise();
};

var getPlaylistID = function(playlistString) {

	var result = $.Deferred(), cached = playlistCache.get(playlistString);
	if (cached) {
		result.resolve(cached);
	}
	else {
		dbConnectionPool.acquire(function(acquireError, connection) {
			if (acquireError) {
				result.reject();
				dbConnectionPool.release(connection);
				return;
			}
			var sha256 = crypto.createHash('sha256');
			sha256.update(playlistString, 'utf8');
			var hash = sha256.digest('hex');
			var queryString = "SELECT id FROM Playlists WHERE sha256=?;";
			connection.query(queryString, [hash], function(queryError, rows) {
				
				if (!queryError && rows) {
					if (rows[0]) {
						var id = parseInt(rows[0]["id"]);
						playlistCache.put(playlistString, id);
						result.resolve(id);
					}
					else {
						result.resolve(false);
					}
				}
				else {
					result.reject();
				}
				dbConnectionPool.release(connection);
			});
		});
	}
	return result.promise();
};

var getPlaylistString = function(id) {
	var result = $.Deferred();
	dbConnectionPool.acquire(function(acquireError, connection) {
		if (acquireError) {
			result.reject();
			dbConnectionPool.release(connection);
			return;
		}
		var queryString = "SELECT playliststring FROM Playlists WHERE id=?;";
		connection.query(queryString, [id], function(queryError, rows) {
			if (!queryError && rows) {
				if (rows[0]) {
					result.resolve(rows[0]["playliststring"]);
				}
				else {
					if (queryError) {
						console.log(queryError);
					}
					result.reject(false);
				}
			}
			else {
				result.reject();
			}
			dbConnectionPool.release(connection);
		});
	});
	return result.promise();
};

var savePlaylist = function(playlist) {
	var playlistString = toQueryString(playlist);
	var result = $.Deferred(), verified = verifyPlaylist(playlist);
	$.when(verified).fail(function() {
		console.log('could not verify', playlist);
		result.reject();
	}).done(function() {
		dbConnectionPool.acquire(function(acquireError, connection) {
			if (acquireError) {
				result.reject();
				dbConnectionPool.release(connection);
				return;
			}
			var sha256 = crypto.createHash('sha256');
			sha256.update(playlistString, 'utf8');
			var hash = sha256.digest('hex');
			var queryString = "INSERT INTO Playlists SET ? ON DUPLICATE KEY UPDATE id=id";
			connection.query(queryString, {sha256: hash, playliststring: playlistString}, function(queryError, rows) {
				if (!queryError) {
					result.resolve(rows.insertId);
				}
				else {
					console.log(queryError);
					result.reject();
				}
				dbConnectionPool.release(connection);
			});
		});
	});
	
	return result.promise();
};

var toQueryString = function(queryArray) {
	queryArray = queryArray || [];
	var qs = '', i = 0, elem = null;
	if (!queryArray.length) {
		return qs;
	}
	qs += queryArray[0]['siteCode'] + '=' +queryArray[0]['siteMediaID'];
	for (i = 1; i < queryArray.length; i++) {
		elem = queryArray[i];
		qs += '&' + queryArray[i]['siteCode'] + '=' +queryArray[i]['siteMediaID'];
	}
	return qs;
}

module.exports = {
	getID: getPlaylistID,
	getString: getPlaylistString,
	save: savePlaylist,
	toQueryString: toQueryString
};